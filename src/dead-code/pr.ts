import type { Octokit } from '@octokit/rest';
import type { DeadCodeCategory, DeadCodeFinding } from '../types.js';
import type { FixResult } from './fix.js';
import { getToken, parseRepo, scrubToken } from '../github.js';
import { excerpt, execCommand } from './exec.js';

export interface DeadCodePROptions {
  /** Defaults to the repo's default branch. */
  baseBranch?: string;
  /** Cap findings listed in the PR body (default 100, with a "+N more" line). */
  maxFindingsInBody?: number;
}

const BRANCH_PREFIX = 'repo-janitor/';
const PR_TITLE = '🧹 Remove dead code (repo-janitor)';
const COMMIT_MESSAGE = 'chore: remove dead code (repo-janitor)';
const DEFAULT_MAX_FINDINGS = 100;
const GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Turn the (already fixed) working tree into a pull request.
 *
 * Behavior contract:
 * - If ANY open PR in the target repo has a head branch starting with
 *   "repo-janitor/", do nothing and return null (no PR spam — one at a time).
 * - Branch name: repo-janitor/dead-code-<YYYY-MM-DD>.
 * - Commits with a bot-ish author ("repo-janitor"), pushes using the janitor
 *   token via http.extraheader (never embedding the token in the remote URL),
 *   token scrubbed from errors.
 * - PR body: what was removed (grouped by category), the verification log
 *   (which commands ran), and a note that the branch was verified green.
 * - Returns the PR html_url.
 */
export async function createDeadCodePR(
  octokit: Octokit,
  repoFullName: string,
  repoDir: string,
  findings: DeadCodeFinding[],
  fix: FixResult,
  opts: DeadCodePROptions = {},
): Promise<{ url: string } | null> {
  const { owner, name } = parseRepo(repoFullName);
  const token = getToken();

  try {
    // Paginate: in PR-heavy repos an older janitor PR can sit beyond the
    // first page, and missing it would open the duplicate this guard exists
    // to prevent.
    const open = await octokit.paginate(octokit.pulls.list, {
      owner,
      repo: name,
      state: 'open',
      per_page: 100,
    });
    if (open.some((pr) => pr.head.ref.startsWith(BRANCH_PREFIX))) return null;

    const branch = `${BRANCH_PREFIX}dead-code-${new Date().toISOString().slice(0, 10)}`;

    await git(repoDir, token, ['checkout', '-b', branch]);
    // Stage only what knip changed — the working tree also holds install and
    // verify artifacts (package-lock.json, build output) that must stay out.
    await git(repoDir, token, ['add', '--', ...fix.changedFiles]);
    await git(repoDir, token, [
      '-c',
      'user.name=repo-janitor',
      '-c',
      'user.email=repo-janitor@users.noreply.github.com',
      'commit',
      '-m',
      COMMIT_MESSAGE,
    ]);
    // --force: the repo-janitor/* namespace is bot-owned and the guard above
    // ensures no open janitor PR exists, so a stale same-day branch left by a
    // partial failure (push succeeded, PR create didn't) must not wedge reruns.
    await git(repoDir, token, [
      '-c',
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicCredential(token)}`,
      'push',
      '--force',
      'origin',
      branch,
    ]);

    const base =
      opts.baseBranch ?? (await octokit.repos.get({ owner, repo: name })).data.default_branch;

    const created = await octokit.pulls.create({
      owner,
      repo: name,
      title: PR_TITLE,
      head: branch,
      base,
      body: renderBody(findings, fix, opts.maxFindingsInBody ?? DEFAULT_MAX_FINDINGS),
    });
    return { url: created.data.html_url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(scrubToken(message, token));
  }
}

function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

async function git(repoDir: string, token: string, args: string[]): Promise<void> {
  const result = await execCommand('git', args, { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0) {
    const detail = excerpt(result.stderr || result.stdout);
    throw new Error(
      scrubToken(`git ${args.join(' ')} failed (exit ${result.code}): ${detail}`, token),
    );
  }
}

// ---------------------------------------------------------------------------
// PR body rendering
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<DeadCodeCategory, string> = {
  'unused-file': 'Unused files',
  'unused-export': 'Unused exports',
  'unused-type': 'Unused types',
  'unused-enum-member': 'Unused enum members',
  'unused-class-member': 'Unused class members',
  'unused-dependency': 'Unused dependencies',
  'unlisted-dependency': 'Unlisted dependencies',
  'unresolved-import': 'Unresolved imports',
  'duplicate-export': 'Duplicate exports',
  other: 'Other',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as DeadCodeCategory[];

function renderBody(findings: DeadCodeFinding[], fix: FixResult, maxFindings: number): string {
  const lines = [
    'Automated dead-code cleanup by **repo-janitor**, based on a [Knip](https://knip.dev) scan.',
    'Only safe auto-fixes were applied; review before merging.',
    '',
    `## Findings (${findings.length})`,
    '',
  ];

  const byCategory = new Map<DeadCodeCategory, DeadCodeFinding[]>();
  for (const finding of findings) {
    const group = byCategory.get(finding.category);
    if (group) group.push(finding);
    else byCategory.set(finding.category, [finding]);
  }

  let listed = 0;
  for (const category of CATEGORY_ORDER) {
    const group = byCategory.get(category);
    if (!group || listed >= maxFindings) continue;

    lines.push(`### ${CATEGORY_LABELS[category]} (${group.length})`, '');
    const sorted = [...group].sort(
      (a, b) => a.file.localeCompare(b.file) || (a.name ?? '').localeCompare(b.name ?? ''),
    );
    for (const finding of sorted) {
      if (listed >= maxFindings) break;
      const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(finding.name ? `- \`${finding.name}\` — ${location}` : `- ${location}`);
      listed += 1;
    }
    lines.push('');
  }
  if (listed < findings.length) {
    lines.push(`_+${findings.length - listed} more not listed._`, '');
  }

  lines.push(
    '<details>',
    '<summary>Fix &amp; verification log</summary>',
    '',
    '```',
    ...fix.log,
    '```',
    '',
    '</details>',
    '',
    '---',
    '',
    '✅ Verification passed: every verify command exited 0 on this branch before the PR was opened.',
    '',
    '_Generated by repo-janitor._',
  );
  return lines.join('\n');
}

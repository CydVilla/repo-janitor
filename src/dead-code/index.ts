import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  DeadCodeCategory,
  DeadCodeFinding,
  DeadCodeRunResult,
  JanitorConfig,
  RepoConfig,
} from '../types.js';
import { cloneRepo, getOctokit, parseRepo } from '../github.js';
import { upsertReportIssue } from '../reporting/issue.js';
import { applyKnipFixes } from './fix.js';
import { createDeadCodePR } from './pr.js';
import { installDependencies, runKnip } from './run.js';

const ISSUE_TITLE = '🧹 Dead code report';
const JANITOR_LABEL = 'repo-janitor';

/**
 * Deep enough that pushing the janitor branch from a shallow clone is safe;
 * a full clone of large repos would be needlessly slow.
 */
const CLONE_DEPTH = 50;

/** Cap on findings listed in the report issue body. */
const MAX_FINDINGS_IN_ISSUE = 200;

export interface DeadCodeScanOptions {
  /** Scratch dir for clones (default '.work'); cleaned per repo. */
  workDir?: string;
}

/**
 * Run the dead-code sweep for every onboarded repo with deadCode.enabled.
 *
 * Per repo: clone (full enough for a branch push) → installDependencies →
 * runKnip. With findings: when openPRs, applyKnipFixes and, if applied &&
 * verified, createDeadCodePR; when !openPRs (or nothing auto-fixable, or
 * verification failed), upsert a findings issue in the target repo instead.
 * A failure in one repo is captured in its result and never aborts the
 * others. Appends a summary to GITHUB_STEP_SUMMARY when present.
 */
export async function runDeadCodeScan(
  config: JanitorConfig,
  opts: DeadCodeScanOptions = {},
): Promise<DeadCodeRunResult[]> {
  const workDir = opts.workDir ?? '.work';

  const results: DeadCodeRunResult[] = [];
  for (const repoConfig of config.repos) {
    if (!repoConfig.deadCode.enabled) continue;
    results.push(await sweepOneRepo(repoConfig, workDir));
  }

  await appendStepSummary(results);
  return results;
}

async function sweepOneRepo(repoConfig: RepoConfig, workDir: string): Promise<DeadCodeRunResult> {
  const result: DeadCodeRunResult = { repo: repoConfig.repo, findingCount: 0 };

  const { owner, name } = parseRepo(repoConfig.repo);
  const repoDir = path.join(workDir, `${owner}__${name}`);

  try {
    await rm(repoDir, { recursive: true, force: true });
    await cloneRepo(repoConfig.repo, repoDir, { branch: repoConfig.branch, depth: CLONE_DEPTH });
    await installDependencies(repoDir);

    const knip = await runKnip(repoDir);
    if (knip.knipError) throw new Error(`knip failed: ${knip.knipError}`);
    result.findingCount = knip.findings.length;
    if (knip.findings.length === 0) return result;

    if (repoConfig.deadCode.openPRs) {
      const fix = await applyKnipFixes(repoDir, {
        fixTypes: repoConfig.deadCode.fixTypes,
        verifyCommands: repoConfig.deadCode.verifyCommands,
      });
      result.verified = fix.verified;

      if (fix.applied && fix.verified) {
        const pr = await createDeadCodePR(
          getOctokit(),
          repoConfig.repo,
          repoDir,
          knip.findings,
          fix,
          { baseBranch: repoConfig.branch },
        );
        if (pr) result.prUrl = pr.url;
        // pr === null means a janitor PR is already open; the findings are
        // already in front of the maintainer, so don't also file an issue.
        return result;
      }
    }

    const issue = await upsertReportIssue(getOctokit(), repoConfig.repo, {
      title: ISSUE_TITLE,
      body: renderFindingsIssue(repoConfig.repo, knip.findings),
      labels: [JANITOR_LABEL],
    });
    result.issueUrl = issue.url;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[dead-code] ${repoConfig.repo}: ${result.error}`);
  } finally {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }

  return result;
}

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

function renderFindingsIssue(repo: string, findings: DeadCodeFinding[]): string {
  const lines = [
    `Knip found **${findings.length}** potential dead-code item${findings.length === 1 ? '' : 's'} in \`${repo}\`.`,
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
    if (!group || listed >= MAX_FINDINGS_IN_ISSUE) continue;

    lines.push(`### ${CATEGORY_LABELS[category]} (${group.length})`, '');
    const sorted = [...group].sort(
      (a, b) => a.file.localeCompare(b.file) || (a.name ?? '').localeCompare(b.name ?? ''),
    );
    for (const finding of sorted) {
      if (listed >= MAX_FINDINGS_IN_ISSUE) break;
      const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(finding.name ? `- \`${finding.name}\` — ${location}` : `- ${location}`);
      listed += 1;
    }
    lines.push('');
  }
  if (listed < findings.length) {
    lines.push(`…and ${findings.length - listed} more.`, '');
  }

  lines.push(
    '---',
    '',
    '_Generated by repo-janitor. Knip cannot see dynamic imports, reflection, or_',
    '_runtime string lookups — treat these as candidates, not verdicts._',
  );
  return lines.join('\n');
}

async function appendStepSummary(results: DeadCodeRunResult[]): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || results.length === 0) return;

  const lines = [
    '## 🧹 Dead code sweep',
    '',
    '| Repo | Findings | Verified | PR | Issue | Error |',
    '| --- | ---: | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const verified = r.verified === undefined ? '—' : r.verified ? 'yes' : 'no';
    const pr = r.prUrl ? `[PR](${r.prUrl})` : '—';
    const issue = r.issueUrl ? `[issue](${r.issueUrl})` : '—';
    lines.push(`| ${r.repo} | ${r.findingCount} | ${verified} | ${pr} | ${issue} | ${mdCell(r.error)} |`);
  }
  await appendFile(summaryPath, lines.join('\n') + '\n\n');
}

/** Error messages contain newlines and pipes (git output) that break table rows. */
function mdCell(text: string | undefined): string {
  if (!text) return '—';
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 300);
}

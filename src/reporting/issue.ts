import type { Octokit } from '@octokit/rest';
import { parseRepo } from '../github.js';

const JANITOR_LABEL = 'repo-janitor';
const LABEL_COLOR = 'ededed';
const LABEL_DESCRIPTION = 'Automated reports from the repo-janitor hub';

interface IssueLite {
  number: number;
  title: string;
  html_url: string;
  /** Present when the entry is actually a pull request (issues API returns both). */
  pull_request?: unknown;
}

async function listOpenCandidates(octokit: Octokit, owner: string, repo: string): Promise<IssueLite[]> {
  const base = { owner, repo, state: 'open' as const, per_page: 100 };
  try {
    const res = await octokit.issues.listForRepo({ ...base, labels: JANITOR_LABEL });
    return res.data;
  } catch {
    // The label may not exist yet in the target repo; some setups error on a
    // filter for a missing label. Fall back to scanning all open issues —
    // exact-title matching below still prevents duplicates.
    const res = await octokit.issues.listForRepo(base);
    return res.data;
  }
}

/**
 * Find the OPEN issue (never a PR) in the target repo with this exact title,
 * searching issues carrying the 'repo-janitor' label. Returns null when no
 * such issue exists.
 */
export async function findOpenReportIssue(
  octokit: Octokit,
  targetRepo: string,
  title: string,
): Promise<{ number: number; url: string } | null> {
  const { owner, name } = parseRepo(targetRepo);
  const candidates = await listOpenCandidates(octokit, owner, name);
  const existing = candidates.find((issue) => issue.title === title && !issue.pull_request);
  return existing ? { number: existing.number, url: existing.html_url } : null;
}

/**
 * Find an OPEN issue in the target repo with this exact title (searching
 * issues carrying the 'repo-janitor' label) and update its body; otherwise
 * create it with the label. Never creates duplicates.
 *
 * Note: subscribers of the issue get GitHub email notifications on every
 * update — this is the "GitHub-only email report" mechanism.
 */
export async function upsertReportIssue(
  octokit: Octokit,
  targetRepo: string,
  opts: { title: string; body: string; labels?: string[] },
): Promise<{ url: string; created: boolean }> {
  const { owner, name } = parseRepo(targetRepo);

  const candidates = await listOpenCandidates(octokit, owner, name);
  const existing = candidates.find((issue) => issue.title === opts.title && !issue.pull_request);

  if (existing) {
    await octokit.issues.update({
      owner,
      repo: name,
      issue_number: existing.number,
      body: opts.body,
    });
    return { url: existing.html_url, created: false };
  }

  // Classic push tokens auto-create missing labels on issue creation, but
  // fine-grained PATs reject them with 422 "Label invalid" — so ensure the
  // labels exist first, and as a last resort file the report unlabeled.
  const labels = [JANITOR_LABEL, ...(opts.labels ?? [])];
  for (const label of labels) {
    await ensureLabelExists(octokit, owner, name, label);
  }

  const params = { owner, repo: name, title: opts.title, body: opts.body };
  try {
    const created = await octokit.issues.create({ ...params, labels });
    return { url: created.data.html_url, created: true };
  } catch (err) {
    if (!isLabelValidationError(err)) throw err;
    const created = await octokit.issues.create(params);
    return { url: created.data.html_url, created: true };
  }
}

async function ensureLabelExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  label: string,
): Promise<void> {
  try {
    await octokit.issues.getLabel({ owner, repo, name: label });
  } catch {
    try {
      await octokit.issues.createLabel({
        owner,
        repo,
        name: label,
        color: LABEL_COLOR,
        description: LABEL_DESCRIPTION,
      });
    } catch {
      // Racing another run, or the token can't manage labels — the unlabeled
      // fallback in upsertReportIssue keeps the report itself flowing.
    }
  }
}

function isLabelValidationError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 422 && /"resource"\s*:\s*"Label"/.test(e?.message ?? '');
}

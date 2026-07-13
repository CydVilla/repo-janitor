import type { Octokit } from '@octokit/rest';
import { parseRepo } from '../github.js';

const JANITOR_LABEL = 'repo-janitor';

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

  // GitHub auto-creates missing labels on issue creation when the token has
  // push access, so passing the labels array here needs no pre-check.
  const created = await octokit.issues.create({
    owner,
    repo: name,
    title: opts.title,
    body: opts.body,
    labels: [JANITOR_LABEL, ...(opts.labels ?? [])],
  });
  return { url: created.data.html_url, created: true };
}

import type { Octokit } from '@octokit/rest';
import type { FalsePositiveReport, LinkRecord } from '../types.js';
import { parseRepo } from '../github.js';
import { findOpenReportIssue } from '../reporting/issue.js';

const COMMENTS_PER_PAGE = 100;

/**
 * Directive syntax, one per line anywhere in an issue comment:
 *
 *     /false-positive <url>        (alias: /fp)
 *     /not-false-positive <url>    (alias: /not-fp)
 *
 * The URL may be wrapped in backticks or <angle brackets> — GitHub's Markdown
 * editor and autolinking add both — and trailing sentence punctuation is
 * ignored. Command names are case-insensitive; URLs are matched exactly as
 * tracked (no normalization beyond unwrapping).
 */
const DIRECTIVE_RE = /^\/(false-positive|fp|not-false-positive|not-fp)\s+(\S+)\s*$/i;

export interface FalsePositiveDirective {
  action: 'mark' | 'unmark';
  url: string;
}

/** Extract every false-positive directive from one comment body, in order. */
export function parseFalsePositiveDirectives(body: string): FalsePositiveDirective[] {
  const directives: FalsePositiveDirective[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const match = DIRECTIVE_RE.exec(rawLine.trim());
    if (!match || !match[1] || !match[2]) continue;
    const command = match[1].toLowerCase();
    const url = unwrapUrl(match[2]);
    if (!url) continue;
    directives.push({ action: command.startsWith('not-') ? 'unmark' : 'mark', url });
  }
  return directives;
}

/** Strip backticks / <angle brackets> and trailing sentence punctuation. */
function unwrapUrl(token: string): string {
  let url = token.trim();
  // Unwrap pairs first so "`<url>`" also works.
  for (const [open, close] of [
    ['`', '`'],
    ['<', '>'],
  ] as const) {
    if (url.startsWith(open) && url.endsWith(close) && url.length >= 2) {
      url = url.slice(1, -1);
    }
  }
  return url.replace(/[.,;:!?]+$/, '');
}

/**
 * Read false-positive reports from the comments of the open report issue.
 *
 * Comments are processed oldest-first (GitHub's default order), and within a
 * comment top-to-bottom, so the latest directive for a URL wins — commenting
 * `/not-false-positive <url>` re-enables reporting. Deleting the marking
 * comment has the same effect, because the map is rebuilt from the live
 * comment thread on every scan.
 *
 * Returns an empty map when the report issue does not exist (nothing to read
 * reports from yet).
 */
export async function fetchFalsePositiveReports(
  octokit: Octokit,
  targetRepo: string,
  issueTitle: string,
): Promise<Record<string, FalsePositiveReport>> {
  const issue = await findOpenReportIssue(octokit, targetRepo, issueTitle);
  if (!issue) return {};

  const { owner, name } = parseRepo(targetRepo);
  const reports: Record<string, FalsePositiveReport> = {};

  for (let page = 1; ; page += 1) {
    const res = await octokit.issues.listComments({
      owner,
      repo: name,
      issue_number: issue.number,
      per_page: COMMENTS_PER_PAGE,
      page,
    });
    for (const comment of res.data) {
      if (!comment.body) continue;
      for (const directive of parseFalsePositiveDirectives(comment.body)) {
        if (directive.action === 'unmark') {
          delete reports[directive.url];
        } else {
          reports[directive.url] = {
            url: directive.url,
            reportedBy: comment.user?.login ?? 'unknown',
            reportedAt: comment.created_at,
            commentUrl: comment.html_url,
          };
        }
      }
    }
    if (res.data.length < COMMENTS_PER_PAGE) break;
  }

  return reports;
}

/**
 * Keep only reports for URLs the scan still tracks — a report for a link that
 * was removed from the repo is stale and would otherwise linger forever.
 */
export function pruneFalsePositives(
  reports: Record<string, FalsePositiveReport>,
  links: Record<string, LinkRecord>,
): Record<string, FalsePositiveReport> {
  const pruned: Record<string, FalsePositiveReport> = {};
  for (const [url, report] of Object.entries(reports)) {
    if (links[url]) pruned[url] = report;
  }
  return pruned;
}

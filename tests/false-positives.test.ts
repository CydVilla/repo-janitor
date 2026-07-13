import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import {
  fetchFalsePositiveReports,
  parseFalsePositiveDirectives,
  pruneFalsePositives,
} from '../src/link-checker/false-positives.js';
import type { FalsePositiveReport, LinkRecord } from '../src/types.js';

const URL_A = 'https://a.example.com/';
const URL_B = 'https://b.example.com/';

describe('parseFalsePositiveDirectives', () => {
  it('parses a single mark directive', () => {
    expect(parseFalsePositiveDirectives(`/false-positive ${URL_A}`)).toEqual([
      { action: 'mark', url: URL_A },
    ]);
  });

  it('parses an unmark directive', () => {
    expect(parseFalsePositiveDirectives(`/not-false-positive ${URL_A}`)).toEqual([
      { action: 'unmark', url: URL_A },
    ]);
  });

  it('accepts the /fp and /not-fp aliases', () => {
    expect(parseFalsePositiveDirectives(`/fp ${URL_A}\n/not-fp ${URL_B}`)).toEqual([
      { action: 'mark', url: URL_A },
      { action: 'unmark', url: URL_B },
    ]);
  });

  it('is case-insensitive about the command name', () => {
    expect(parseFalsePositiveDirectives(`/False-Positive ${URL_A}`)).toEqual([
      { action: 'mark', url: URL_A },
    ]);
  });

  it('parses multiple directives per comment, in order, ignoring prose', () => {
    const body = [
      'These two are behind our VPN, the checker just cannot see them:',
      '',
      `/false-positive ${URL_A}`,
      `/false-positive ${URL_B}`,
      '',
      'Thanks!',
    ].join('\n');
    expect(parseFalsePositiveDirectives(body)).toEqual([
      { action: 'mark', url: URL_A },
      { action: 'mark', url: URL_B },
    ]);
  });

  it('unwraps backticks and <angle brackets> around the URL', () => {
    expect(parseFalsePositiveDirectives(`/false-positive \`${URL_A}\``)).toEqual([
      { action: 'mark', url: URL_A },
    ]);
    expect(parseFalsePositiveDirectives(`/false-positive <${URL_A}>`)).toEqual([
      { action: 'mark', url: URL_A },
    ]);
    expect(parseFalsePositiveDirectives(`/false-positive \`<${URL_A}>\``)).toEqual([
      { action: 'mark', url: URL_A },
    ]);
  });

  it('strips trailing sentence punctuation from the URL', () => {
    expect(parseFalsePositiveDirectives(`/false-positive ${URL_A}.`)).toEqual([
      { action: 'mark', url: URL_A },
    ]);
  });

  it('tolerates surrounding whitespace and CRLF line endings', () => {
    expect(parseFalsePositiveDirectives(`  /false-positive ${URL_A}  \r\n`)).toEqual([
      { action: 'mark', url: URL_A },
    ]);
  });

  it('ignores directives not at the start of a line', () => {
    expect(parseFalsePositiveDirectives(`please run /false-positive ${URL_A}`)).toEqual([]);
  });

  it('ignores a directive with no URL', () => {
    expect(parseFalsePositiveDirectives('/false-positive')).toEqual([]);
  });

  it('ignores a directive with extra tokens after the URL', () => {
    expect(parseFalsePositiveDirectives(`/false-positive ${URL_A} because reasons`)).toEqual([]);
  });

  it('returns an empty list for a comment without directives', () => {
    expect(parseFalsePositiveDirectives('just a regular comment')).toEqual([]);
  });
});

interface FakeComment {
  body?: string;
  user?: { login: string } | null;
  created_at: string;
  html_url: string;
}

function comment(body: string, overrides: Partial<FakeComment> = {}): FakeComment {
  return {
    body,
    user: { login: 'octocat' },
    created_at: '2026-03-01T00:00:00Z',
    html_url: 'https://github.com/octo/site/issues/1#issuecomment-1',
    ...overrides,
  };
}

function fakeOctokit(issues: Array<{ number: number; title: string }>, comments: FakeComment[]) {
  const listForRepo = vi.fn(async () => ({
    data: issues.map((i) => ({ ...i, html_url: `https://github.com/octo/site/issues/${i.number}` })),
  }));
  const listComments = vi.fn(async (params: { page?: number; per_page?: number }) => {
    const page = params.page ?? 1;
    const perPage = params.per_page ?? 100;
    return { data: comments.slice((page - 1) * perPage, page * perPage) };
  });
  const octokit = { issues: { listForRepo, listComments } } as unknown as Octokit;
  return { octokit, listForRepo, listComments };
}

const ISSUE_TITLE = '🔗 Link health report';
const REPORT_ISSUE = { number: 1, title: ISSUE_TITLE };

describe('fetchFalsePositiveReports', () => {
  it('returns an empty map when no report issue exists', async () => {
    const { octokit, listComments } = fakeOctokit([], []);
    await expect(fetchFalsePositiveReports(octokit, 'octo/site', ISSUE_TITLE)).resolves.toEqual(
      {},
    );
    expect(listComments).not.toHaveBeenCalled();
  });

  it('collects marks from comments with author, timestamp, and comment URL', async () => {
    const { octokit } = fakeOctokit(
      [REPORT_ISSUE],
      [
        comment(`/false-positive ${URL_A}`, {
          user: { login: 'alice' },
          created_at: '2026-03-02T09:00:00Z',
          html_url: 'https://github.com/octo/site/issues/1#issuecomment-7',
        }),
      ],
    );

    await expect(fetchFalsePositiveReports(octokit, 'octo/site', ISSUE_TITLE)).resolves.toEqual({
      [URL_A]: {
        url: URL_A,
        reportedBy: 'alice',
        reportedAt: '2026-03-02T09:00:00Z',
        commentUrl: 'https://github.com/octo/site/issues/1#issuecomment-7',
      },
    });
  });

  it('lets a later unmark cancel an earlier mark', async () => {
    const { octokit } = fakeOctokit(
      [REPORT_ISSUE],
      [comment(`/false-positive ${URL_A}`), comment(`/not-false-positive ${URL_A}`)],
    );
    await expect(fetchFalsePositiveReports(octokit, 'octo/site', ISSUE_TITLE)).resolves.toEqual(
      {},
    );
  });

  it('lets a later mark win after an unmark', async () => {
    const { octokit } = fakeOctokit(
      [REPORT_ISSUE],
      [
        comment(`/false-positive ${URL_A}`),
        comment(`/not-false-positive ${URL_A}`),
        comment(`/false-positive ${URL_A}`, { user: { login: 'bob' } }),
      ],
    );
    const reports = await fetchFalsePositiveReports(octokit, 'octo/site', ISSUE_TITLE);
    expect(reports[URL_A]?.reportedBy).toBe('bob');
  });

  it('paginates through more than one page of comments', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => comment(`comment ${i}`));
    const { octokit, listComments } = fakeOctokit(
      [REPORT_ISSUE],
      [...filler, comment(`/false-positive ${URL_A}`)],
    );
    const reports = await fetchFalsePositiveReports(octokit, 'octo/site', ISSUE_TITLE);
    expect(Object.keys(reports)).toEqual([URL_A]);
    expect(listComments).toHaveBeenCalledTimes(2);
  });

  it('skips comments with no body and falls back to "unknown" for missing authors', async () => {
    const { octokit } = fakeOctokit(
      [REPORT_ISSUE],
      [
        comment('', { body: undefined }),
        comment(`/false-positive ${URL_A}`, { user: null }),
      ],
    );
    const reports = await fetchFalsePositiveReports(octokit, 'octo/site', ISSUE_TITLE);
    expect(reports[URL_A]?.reportedBy).toBe('unknown');
  });

  it('ignores issues with other titles', async () => {
    const { octokit, listComments } = fakeOctokit(
      [{ number: 2, title: 'Something else' }],
      [comment(`/false-positive ${URL_A}`)],
    );
    await expect(fetchFalsePositiveReports(octokit, 'octo/site', ISSUE_TITLE)).resolves.toEqual(
      {},
    );
    expect(listComments).not.toHaveBeenCalled();
  });
});

describe('pruneFalsePositives', () => {
  const report = (url: string): FalsePositiveReport => ({
    url,
    reportedBy: 'octocat',
    reportedAt: '2026-03-01T00:00:00Z',
  });

  it('drops reports for URLs that are no longer tracked', () => {
    const links = { [URL_A]: { url: URL_A } as LinkRecord };
    expect(
      pruneFalsePositives({ [URL_A]: report(URL_A), [URL_B]: report(URL_B) }, links),
    ).toEqual({ [URL_A]: report(URL_A) });
  });

  it('returns an empty map when nothing is tracked', () => {
    expect(pruneFalsePositives({ [URL_A]: report(URL_A) }, {})).toEqual({});
  });
});

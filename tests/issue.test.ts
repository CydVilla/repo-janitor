import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { upsertReportIssue } from '../src/reporting/issue.js';

interface FakeIssue {
  number: number;
  title: string;
  html_url: string;
  pull_request?: object;
}

function fakeOctokit(issues: FakeIssue[], opts: { failLabelFilter?: boolean } = {}) {
  const listForRepo = vi.fn(async (params: { labels?: string }) => {
    if (opts.failLabelFilter && params.labels !== undefined) {
      throw new Error('label filter unsupported');
    }
    return { data: issues };
  });
  const update = vi.fn(async () => ({ data: {} }));
  const create = vi.fn(async () => ({
    data: { html_url: 'https://github.com/octo/repo/issues/42' },
  }));
  const octokit = { issues: { listForRepo, update, create } } as unknown as Octokit;
  return { octokit, listForRepo, update, create };
}

const REPORT = { title: 'Dead link report', body: 'updated body' };

describe('upsertReportIssue', () => {
  it('lists open repo-janitor issues in the target repo', async () => {
    const { octokit, listForRepo } = fakeOctokit([]);

    await upsertReportIssue(octokit, 'octo/repo', REPORT);

    expect(listForRepo).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      state: 'open',
      labels: 'repo-janitor',
      per_page: 100,
    });
  });

  it('updates the body of an existing exact-title issue', async () => {
    const existing: FakeIssue = {
      number: 7,
      title: REPORT.title,
      html_url: 'https://github.com/octo/repo/issues/7',
    };
    const { octokit, update, create } = fakeOctokit([
      { number: 3, title: 'Something else', html_url: 'https://github.com/octo/repo/issues/3' },
      existing,
    ]);

    const result = await upsertReportIssue(octokit, 'octo/repo', REPORT);

    expect(update).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      issue_number: 7,
      body: REPORT.body,
    });
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({ url: existing.html_url, created: false });
  });

  it('creates the issue with repo-janitor plus extra labels when no match exists', async () => {
    const { octokit, update, create } = fakeOctokit([]);

    const result = await upsertReportIssue(octokit, 'octo/repo', {
      ...REPORT,
      labels: ['links'],
    });

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      title: REPORT.title,
      body: REPORT.body,
      labels: ['repo-janitor', 'links'],
    });
    expect(result).toEqual({ url: 'https://github.com/octo/repo/issues/42', created: true });
  });

  it('defaults to only the repo-janitor label', async () => {
    const { octokit, create } = fakeOctokit([]);

    await upsertReportIssue(octokit, 'octo/repo', REPORT);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ labels: ['repo-janitor'] }));
  });

  it('matches titles exactly, never by substring', async () => {
    const { octokit, update, create } = fakeOctokit([
      {
        number: 8,
        title: `${REPORT.title} (weekly)`,
        html_url: 'https://github.com/octo/repo/issues/8',
      },
    ]);

    const result = await upsertReportIssue(octokit, 'octo/repo', REPORT);

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(true);
  });

  it('ignores pull requests with a matching title', async () => {
    const { octokit, update, create } = fakeOctokit([
      {
        number: 9,
        title: REPORT.title,
        html_url: 'https://github.com/octo/repo/pull/9',
        pull_request: {},
      },
    ]);

    const result = await upsertReportIssue(octokit, 'octo/repo', REPORT);

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(true);
  });

  it('falls back to an unfiltered listing when the label filter errors', async () => {
    const existing: FakeIssue = {
      number: 11,
      title: REPORT.title,
      html_url: 'https://github.com/octo/repo/issues/11',
    };
    const { octokit, listForRepo, update, create } = fakeOctokit([existing], {
      failLabelFilter: true,
    });

    const result = await upsertReportIssue(octokit, 'octo/repo', REPORT);

    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(listForRepo).toHaveBeenLastCalledWith({
      owner: 'octo',
      repo: 'repo',
      state: 'open',
      per_page: 100,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 11 }));
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({ url: existing.html_url, created: false });
  });

  it('rejects invalid target repo names', async () => {
    const { octokit, listForRepo } = fakeOctokit([]);

    await expect(upsertReportIssue(octokit, 'not-a-repo', REPORT)).rejects.toThrow(
      /expected "owner\/name"/,
    );
    expect(listForRepo).not.toHaveBeenCalled();
  });
});

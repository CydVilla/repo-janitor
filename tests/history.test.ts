import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  historyFilePath,
  loadHistory,
  mergeOutcomes,
  saveHistory,
} from '../src/link-checker/history.js';
import type {
  LinkCheckOutcome,
  LinkOccurrence,
  LinkRecord,
  RepoLinkHistory,
} from '../src/types.js';

const REPO = 'octo/site';
const URL_A = 'https://a.example.com/';
const URL_B = 'https://b.example.com/';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2026-01-03T00:00:00.000Z';
const T4 = '2026-01-04T00:00:00.000Z';

const OCC: LinkOccurrence[] = [{ file: 'README.md', line: 3 }];

function outcome(
  url: string,
  ok: boolean,
  overrides: Partial<LinkCheckOutcome> = {},
): LinkCheckOutcome {
  return { url, ok, durationMs: 12, checkedAt: T1, ...overrides };
}

function extractedOf(
  ...entries: Array<[string, LinkOccurrence[]]>
): Map<string, LinkOccurrence[]> {
  return new Map(entries);
}

function rec(history: RepoLinkHistory, url: string): LinkRecord {
  const record = history.links[url];
  if (!record) throw new Error(`expected a record for ${url}`);
  return record;
}

function record(url: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    url,
    state: 'ok',
    firstSeenAt: T1,
    lastCheckedAt: T1,
    lastOkAt: T1,
    lastStatusCode: 200,
    consecutiveFailures: 0,
    totalChecks: 1,
    totalFailures: 0,
    occurrences: [...OCC],
    history: [{ at: T1, ok: true, statusCode: 200 }],
    ...overrides,
  };
}

describe('mergeOutcomes state machine', () => {
  it('creates an ok record for a new working URL', () => {
    const merged = mergeOutcomes(
      null,
      REPO,
      extractedOf([URL_A, OCC]),
      [outcome(URL_A, true, { statusCode: 200, checkedAt: T1 })],
      { now: T1 },
    );

    expect(merged.repo).toBe(REPO);
    expect(merged.updatedAt).toBe(T1);
    expect(rec(merged, URL_A)).toEqual(record(URL_A));
  });

  it('creates a failing record for a new broken-ish URL (below threshold)', () => {
    const merged = mergeOutcomes(
      null,
      REPO,
      extractedOf([URL_A, OCC]),
      [outcome(URL_A, false, { statusCode: 404 })],
      { now: T1 },
    );

    const r = rec(merged, URL_A);
    expect(r.state).toBe('failing');
    expect(r.consecutiveFailures).toBe(1);
    expect(r.lastOkAt).toBeNull();
    expect(r.lastStatusCode).toBe(404);
    expect(r.totalChecks).toBe(1);
    expect(r.totalFailures).toBe(1);
    expect(r.firstSeenAt).toBe(T1);
    expect(r.history).toEqual([{ at: T1, ok: false, statusCode: 404 }]);
  });

  it('marks a new URL broken immediately when failThreshold is 1', () => {
    const merged = mergeOutcomes(
      null,
      REPO,
      extractedOf([URL_A, OCC]),
      [outcome(URL_A, false)],
      { now: T1, failThreshold: 1 },
    );

    expect(rec(merged, URL_A).state).toBe('broken');
  });

  it('walks ok -> failing -> failing -> broken at threshold 3, preserving lastOkAt', () => {
    let h = mergeOutcomes(
      null,
      REPO,
      extractedOf([URL_A, OCC]),
      [outcome(URL_A, true, { statusCode: 200, checkedAt: T1 })],
      { now: T1 },
    );
    expect(rec(h, URL_A).state).toBe('ok');

    h = mergeOutcomes(h, REPO, extractedOf([URL_A, OCC]), [
      outcome(URL_A, false, { statusCode: 503, checkedAt: T2 }),
    ], { now: T2 });
    expect(rec(h, URL_A).state).toBe('failing');
    expect(rec(h, URL_A).consecutiveFailures).toBe(1);
    expect(rec(h, URL_A).lastOkAt).toBe(T1);

    h = mergeOutcomes(h, REPO, extractedOf([URL_A, OCC]), [
      outcome(URL_A, false, { statusCode: 503, checkedAt: T3 }),
    ], { now: T3 });
    expect(rec(h, URL_A).state).toBe('failing');
    expect(rec(h, URL_A).consecutiveFailures).toBe(2);

    h = mergeOutcomes(h, REPO, extractedOf([URL_A, OCC]), [
      outcome(URL_A, false, { statusCode: 503, checkedAt: T4 }),
    ], { now: T4 });

    const r = rec(h, URL_A);
    expect(r.state).toBe('broken');
    expect(r.consecutiveFailures).toBe(3);
    expect(r.lastOkAt).toBe(T1); // untouched through every failure
    expect(r.firstSeenAt).toBe(T1);
    expect(r.totalChecks).toBe(4);
    expect(r.totalFailures).toBe(3);
    expect(r.history.map((e) => e.ok)).toEqual([true, false, false, false]);
  });

  it('resets a broken link on recovery', () => {
    const previous: RepoLinkHistory = {
      repo: REPO,
      updatedAt: T3,
      links: {
        [URL_A]: record(URL_A, {
          state: 'broken',
          lastOkAt: T1,
          lastStatusCode: 404,
          consecutiveFailures: 5,
          totalChecks: 6,
          totalFailures: 5,
        }),
      },
    };

    const merged = mergeOutcomes(previous, REPO, extractedOf([URL_A, OCC]), [
      outcome(URL_A, true, { statusCode: 200, checkedAt: T4 }),
    ], { now: T4 });

    const r = rec(merged, URL_A);
    expect(r.state).toBe('ok');
    expect(r.consecutiveFailures).toBe(0);
    expect(r.lastOkAt).toBe(T4);
    expect(r.lastStatusCode).toBe(200);
    expect(r.totalChecks).toBe(7);
    expect(r.totalFailures).toBe(5);
    expect(r.firstSeenAt).toBe(T1);
  });

  it('drops URLs that were removed from the repo', () => {
    const previous: RepoLinkHistory = {
      repo: REPO,
      updatedAt: T1,
      links: { [URL_A]: record(URL_A), [URL_B]: record(URL_B) },
    };

    const merged = mergeOutcomes(previous, REPO, extractedOf([URL_A, OCC]), [
      outcome(URL_A, true, { statusCode: 200 }),
    ], { now: T2 });

    expect(Object.keys(merged.links)).toEqual([URL_A]);
  });

  it('keeps an extracted-but-unchecked URL with fresh occurrences only', () => {
    const previous: RepoLinkHistory = {
      repo: REPO,
      updatedAt: T1,
      links: { [URL_A]: record(URL_A, { state: 'failing', consecutiveFailures: 2, lastOkAt: null }) },
    };
    const freshOccurrences: LinkOccurrence[] = [{ file: 'docs/guide.md', line: 42 }];

    const merged = mergeOutcomes(previous, REPO, extractedOf([URL_A, freshOccurrences]), [], {
      now: T2,
    });

    const r = rec(merged, URL_A);
    expect(r.occurrences).toEqual(freshOccurrences);
    expect({ ...r, occurrences: [] }).toEqual({
      ...record(URL_A, { state: 'failing', consecutiveFailures: 2, lastOkAt: null }),
      occurrences: [],
    });
    expect(merged.updatedAt).toBe(T2);
  });

  it('ignores a brand-new URL that was extracted but never checked', () => {
    const merged = mergeOutcomes(null, REPO, extractedOf([URL_A, OCC]), [], { now: T1 });
    expect(merged.links).toEqual({});
  });

  it('caps per-link history at maxHistoryEntries, newest last', () => {
    let h: RepoLinkHistory | null = null;
    for (const [i, at] of ['01', '02', '03', '04', '05', '06', '07'].entries()) {
      h = mergeOutcomes(h, REPO, extractedOf([URL_A, OCC]), [
        outcome(URL_A, i % 2 === 0, { statusCode: 200 + i, checkedAt: `2026-02-${at}T00:00:00.000Z` }),
      ], { now: `2026-02-${at}T00:00:00.000Z`, maxHistoryEntries: 5 });
    }

    const r = rec(h as RepoLinkHistory, URL_A);
    expect(r.history).toHaveLength(5);
    expect(r.history.map((e) => e.at)).toEqual([
      '2026-02-03T00:00:00.000Z',
      '2026-02-04T00:00:00.000Z',
      '2026-02-05T00:00:00.000Z',
      '2026-02-06T00:00:00.000Z',
      '2026-02-07T00:00:00.000Z',
    ]);
    expect(r.totalChecks).toBe(7); // counters are not affected by the cap
  });

  it('records redirectedTo from the latest outcome and clears it when gone', () => {
    let h = mergeOutcomes(null, REPO, extractedOf([URL_A, OCC]), [
      outcome(URL_A, true, { statusCode: 301, redirectedTo: 'https://moved.example.com/' }),
    ], { now: T1 });
    expect(rec(h, URL_A).redirectedTo).toBe('https://moved.example.com/');

    h = mergeOutcomes(h, REPO, extractedOf([URL_A, OCC]), [
      outcome(URL_A, true, { statusCode: 200, checkedAt: T2 }),
    ], { now: T2 });
    expect(rec(h, URL_A).redirectedTo).toBeUndefined();
  });
});

describe('historyFilePath', () => {
  it('builds data/links/<owner>__<name>.json', () => {
    expect(historyFilePath('data', 'octo/site')).toBe(
      path.join('data', 'links', 'octo__site.json'),
    );
  });

  it('sanitizes characters outside [A-Za-z0-9_.-]', () => {
    expect(historyFilePath('/d', 'we ird/na@me!')).toBe(
      path.join('/d', 'links', 'we-ird__na-me-.json'),
    );
  });

  it('keeps allowed characters untouched', () => {
    expect(historyFilePath('d', 'A-b_c.9/x.y-z_2')).toBe(
      path.join('d', 'links', 'A-b_c.9__x.y-z_2.json'),
    );
  });
});

describe('loadHistory / saveHistory', () => {
  const tmpDirs: string[] = [];

  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'repo-janitor-history-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('returns null when no history file exists', async () => {
    const dir = await tmpDir();
    await expect(loadHistory(dir, REPO)).resolves.toBeNull();
  });

  it('round-trips through save and load', async () => {
    const dir = await tmpDir();
    const history: RepoLinkHistory = {
      repo: REPO,
      updatedAt: T2,
      links: { [URL_B]: record(URL_B), [URL_A]: record(URL_A, { state: 'failing' }) },
    };

    const filePath = await saveHistory(dir, history);
    expect(filePath).toBe(historyFilePath(dir, REPO));
    await expect(loadHistory(dir, REPO)).resolves.toEqual(history);
  });

  it('writes pretty-printed JSON with alphabetically sorted link keys', async () => {
    const dir = await tmpDir();
    const history: RepoLinkHistory = {
      repo: REPO,
      updatedAt: T1,
      links: {
        'https://z.example.com/': record('https://z.example.com/'),
        'https://a.example.com/': record('https://a.example.com/'),
        'https://m.example.com/': record('https://m.example.com/'),
      },
    };

    const filePath = await saveHistory(dir, history);
    const raw = await readFile(filePath, 'utf8');

    expect(raw).toContain('  "repo"'); // 2-space indent
    expect(raw.endsWith('\n')).toBe(true);
    expect(Object.keys((JSON.parse(raw) as RepoLinkHistory).links)).toEqual([
      'https://a.example.com/',
      'https://m.example.com/',
      'https://z.example.com/',
    ]);
  });

  it('round-trips falsePositives with sorted keys, omitting the field when empty', async () => {
    const dir = await tmpDir();
    const fp = (url: string) => ({ url, reportedBy: 'octocat', reportedAt: T1 });
    const history: RepoLinkHistory = {
      repo: REPO,
      updatedAt: T2,
      links: { [URL_B]: record(URL_B), [URL_A]: record(URL_A) },
      falsePositives: { [URL_B]: fp(URL_B), [URL_A]: fp(URL_A) },
    };

    const filePath = await saveHistory(dir, history);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as RepoLinkHistory;
    expect(Object.keys(parsed.falsePositives ?? {})).toEqual([URL_A, URL_B].sort());
    await expect(loadHistory(dir, REPO)).resolves.toEqual(history);

    await saveHistory(dir, { ...history, falsePositives: {} });
    const withoutFp = await readFile(filePath, 'utf8');
    expect(withoutFp).not.toContain('falsePositives');
  });

  it('is byte-stable across save -> load -> save', async () => {
    const dir = await tmpDir();
    const history: RepoLinkHistory = {
      repo: REPO,
      updatedAt: T3,
      links: { [URL_B]: record(URL_B), [URL_A]: record(URL_A) },
    };

    const filePath = await saveHistory(dir, history);
    const first = await readFile(filePath, 'utf8');
    const reloaded = await loadHistory(dir, REPO);
    await saveHistory(dir, reloaded as RepoLinkHistory);
    const second = await readFile(filePath, 'utf8');

    expect(second).toBe(first);
  });

  it('throws on corrupt JSON, naming the file', async () => {
    const dir = await tmpDir();
    const filePath = historyFilePath(dir, REPO);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ this is not json', 'utf8');

    await expect(loadHistory(dir, REPO)).rejects.toThrow(filePath);
  });
});

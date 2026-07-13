import { describe, expect, it } from 'vitest';
import { renderLinkReport, summarize } from '../src/link-checker/report.js';
import type { LinkRecord, LinkState, RepoLinkHistory } from '../src/types.js';

const REPO = 'octo/site';
const SCANNED_AT = '2026-03-05T12:00:00.000Z';

const EM_DASH = '—';

function record(url: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    url,
    state: 'ok',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastCheckedAt: SCANNED_AT,
    lastOkAt: SCANNED_AT,
    lastStatusCode: 200,
    consecutiveFailures: 0,
    totalChecks: 5,
    totalFailures: 0,
    occurrences: [{ file: 'README.md', line: 1 }],
    history: [{ at: SCANNED_AT, ok: true, statusCode: 200 }],
    ...overrides,
  };
}

function historyOf(records: LinkRecord[], overrides: Partial<RepoLinkHistory> = {}): RepoLinkHistory {
  const links: Record<string, LinkRecord> = {};
  for (const r of records) links[r.url] = r;
  return { repo: REPO, updatedAt: SCANNED_AT, links, ...overrides };
}

/**
 * The canonical mixed fixture used by several tests:
 * 1 ok, 1 failing (URL and occurrence file contain pipes), and 3 broken links
 * (one never worked, one long dead, one recently dead) — inserted deliberately
 * out of order to exercise the deterministic sorting.
 */
function mixedHistory(): RepoLinkHistory {
  return historyOf([
    record('https://recent.example.com/', {
      state: 'broken',
      firstSeenAt: '2026-02-15T00:00:00.000Z',
      lastOkAt: '2026-03-01T00:00:00.000Z',
      lastStatusCode: 500,
      consecutiveFailures: 3,
      totalChecks: 10,
      totalFailures: 3,
      occurrences: [{ file: 'README.md', line: 12 }],
    }),
    record('https://ok.example.com/'),
    record('https://never.example.com/', {
      state: 'broken',
      firstSeenAt: '2026-02-01T00:00:00.000Z',
      lastOkAt: null,
      lastStatusCode: null,
      consecutiveFailures: 4,
      totalChecks: 4,
      totalFailures: 4,
      occurrences: [],
      history: [],
    }),
    record('https://old.example.com/', {
      state: 'broken',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastOkAt: '2026-01-15T08:30:00.000Z',
      lastStatusCode: 404,
      consecutiveFailures: 6,
      totalChecks: 20,
      totalFailures: 6,
      occurrences: [
        { file: 'src/a.ts', line: 10 },
        { file: 'src/b.ts', line: 20 },
        { file: 'src/c.ts', line: 30 },
        { file: 'src/d.ts', line: 40 },
      ],
    }),
    record('https://flaky.example.com/?a=1|b=2', {
      state: 'failing',
      firstSeenAt: '2026-02-20T00:00:00.000Z',
      lastOkAt: '2026-03-04T00:00:00.000Z',
      lastStatusCode: 503,
      consecutiveFailures: 1,
      totalChecks: 8,
      totalFailures: 1,
      occurrences: [{ file: 'docs/a|b.md', line: 7 }],
    }),
  ]);
}

/** Index of the first line that equals `line` exactly; throws when absent. */
function lineIndex(report: string, line: string): number {
  const idx = report.split('\n').indexOf(line);
  if (idx === -1) throw new Error(`expected report to contain the exact line: ${line}`);
  return idx;
}

describe('summarize', () => {
  it('returns all zeros for an empty history', () => {
    expect(summarize(historyOf([]))).toEqual({
      total: 0,
      ok: 0,
      failing: 0,
      broken: 0,
      suppressed: 0,
    });
  });

  it('counts links by state and totals them', () => {
    expect(summarize(mixedHistory())).toEqual({
      total: 5,
      ok: 1,
      failing: 1,
      broken: 3,
      suppressed: 0,
    });
  });

  it('counts every state independently', () => {
    const states: LinkState[] = ['ok', 'ok', 'ok', 'failing', 'broken', 'broken'];
    const history = historyOf(
      states.map((state, i) =>
        record(`https://example.com/${i}`, {
          state,
          lastOkAt: state === 'ok' ? SCANNED_AT : null,
        }),
      ),
    );
    expect(summarize(history)).toEqual({
      total: 6,
      ok: 3,
      failing: 1,
      broken: 2,
      suppressed: 0,
    });
  });

  it('counts failing/broken false positives as suppressed instead of their state', () => {
    const history = historyOf(
      [
        record('https://fp-broken.example.com/', { state: 'broken', lastOkAt: null }),
        record('https://fp-ok.example.com/'),
        record('https://plain-broken.example.com/', { state: 'broken', lastOkAt: null }),
      ],
      {
        falsePositives: {
          'https://fp-broken.example.com/': {
            url: 'https://fp-broken.example.com/',
            reportedBy: 'octocat',
            reportedAt: SCANNED_AT,
          },
          // Currently ok: the mark is dormant and the link counts as ok.
          'https://fp-ok.example.com/': {
            url: 'https://fp-ok.example.com/',
            reportedBy: 'octocat',
            reportedAt: SCANNED_AT,
          },
        },
      },
    );
    expect(summarize(history)).toEqual({
      total: 3,
      ok: 1,
      failing: 0,
      broken: 1,
      suppressed: 1,
    });
  });
});

describe('renderLinkReport', () => {
  it('renders the empty history byte-for-byte', () => {
    const report = renderLinkReport(historyOf([], { repo: 'octo/empty' }));
    expect(report).toBe(
      [
        '# Link health report for octo/empty',
        '',
        'Scanned at 2026-03-05T12:00:00Z.',
        '',
        '| Total | OK | Failing | Broken | Suppressed |',
        '| ---: | ---: | ---: | ---: | ---: |',
        '| 0 | 0 | 0 | 0 | 0 |',
        '',
        '## Broken links',
        '',
        'None.',
        '',
        '## Failing (not yet confirmed broken)',
        '',
        'None.',
        '',
        '## Suppressed false positives',
        '',
        'None.',
        '',
        '<details>',
        '<summary>All tracked links (0)</summary>',
        '',
        'None.',
        '',
        '</details>',
        '',
        '---',
        '',
        'Wrongly flagged link? Comment `/false-positive <url>` on this issue and the next',
        'scan stops reporting it as dead. Undo with `/not-false-positive <url>`.',
        '',
      ].join('\n'),
    );
  });

  it('renders the mixed fixture byte-for-byte', () => {
    const report = renderLinkReport(mixedHistory());
    expect(report).toBe(
      [
        '# Link health report for octo/site',
        '',
        'Scanned at 2026-03-05T12:00:00Z.',
        '',
        '| Total | OK | Failing | Broken | Suppressed |',
        '| ---: | ---: | ---: | ---: | ---: |',
        '| 5 | 1 | 1 | 3 | 0 |',
        '',
        '## Broken links',
        '',
        '| URL | Last status | Last worked | First seen | Consecutive failures | Found in |',
        '| --- | --- | --- | --- | ---: | --- |',
        `| https://never.example.com/ | ${EM_DASH} | never seen working (first seen 2026-02-01T00:00:00Z) | 2026-02-01T00:00:00Z | 4 | ${EM_DASH} |`,
        '| https://old.example.com/ | 404 | 2026-01-15T08:30:00Z | 2026-01-01T00:00:00Z | 6 | `src/a.ts:10`, `src/b.ts:20`, `src/c.ts:30` +1 more |',
        '| https://recent.example.com/ | 500 | 2026-03-01T00:00:00Z | 2026-02-15T00:00:00Z | 3 | `README.md:12` |',
        '',
        '## Failing (not yet confirmed broken)',
        '',
        '| URL | Last status | Last worked | Consecutive failures | Found in |',
        '| --- | --- | --- | ---: | --- |',
        '| https://flaky.example.com/?a=1\\|b=2 | 503 | 2026-03-04T00:00:00Z | 1 | `docs/a\\|b.md:7` |',
        '',
        '## Suppressed false positives',
        '',
        'None.',
        '',
        '<details>',
        '<summary>All tracked links (5)</summary>',
        '',
        '| URL | State | Last worked |',
        '| --- | --- | --- |',
        '| https://flaky.example.com/?a=1\\|b=2 | failing | 2026-03-04T00:00:00Z |',
        '| https://never.example.com/ | broken | never seen working (first seen 2026-02-01T00:00:00Z) |',
        '| https://ok.example.com/ | ok | 2026-03-05T12:00:00Z |',
        '| https://old.example.com/ | broken | 2026-01-15T08:30:00Z |',
        '| https://recent.example.com/ | broken | 2026-03-01T00:00:00Z |',
        '',
        '</details>',
        '',
        '---',
        '',
        'Wrongly flagged link? Comment `/false-positive <url>` on this issue and the next',
        'scan stops reporting it as dead. Undo with `/not-false-positive <url>`.',
        '',
      ].join('\n'),
    );
  });

  it('contains the summary table matching summarize()', () => {
    const history = mixedHistory();
    const summary = summarize(history);
    const report = renderLinkReport(history);
    expect(report).toContain(
      `| ${summary.total} | ${summary.ok} | ${summary.failing} | ${summary.broken} | ${summary.suppressed} |`,
    );
  });

  describe('suppressed false positives', () => {
    function markedHistory(): RepoLinkHistory {
      const history = mixedHistory();
      history.falsePositives = {
        'https://old.example.com/': {
          url: 'https://old.example.com/',
          reportedBy: 'octocat',
          reportedAt: '2026-03-02T10:00:00.000Z',
          commentUrl: 'https://github.com/octo/site/issues/1#issuecomment-99',
        },
      };
      return history;
    }

    it('moves a marked broken link out of the broken table into the suppressed table', () => {
      const report = renderLinkReport(markedHistory());
      const lines = report.split('\n');
      const brokenHeader = lineIndex(report, '## Broken links');
      const suppressedHeader = lineIndex(report, '## Suppressed false positives');
      const row = lines.findIndex((l) => l.startsWith('| https://old.example.com/'));
      expect(row).toBeGreaterThan(suppressedHeader);
      const brokenSection = lines.slice(brokenHeader, suppressedHeader).join('\n');
      expect(brokenSection).not.toContain('https://old.example.com/');
    });

    it('shows the reporter as a link to the marking comment, and the report date', () => {
      const report = renderLinkReport(markedHistory());
      expect(report).toContain(
        '| https://old.example.com/ | broken | 404 | ' +
          '[@octocat](https://github.com/octo/site/issues/1#issuecomment-99) | 2026-03-02T10:00:00Z |',
      );
    });

    it('shows a plain @login when the report has no comment URL', () => {
      const history = markedHistory();
      delete history.falsePositives?.['https://old.example.com/']?.commentUrl;
      const report = renderLinkReport(history);
      expect(report).toContain('| @octocat | 2026-03-02T10:00:00Z |');
    });

    it('reflects the suppression in the summary table', () => {
      const report = renderLinkReport(markedHistory());
      expect(report).toContain('| 5 | 1 | 1 | 2 | 1 |');
    });

    it('leaves a marked link alone while it is ok', () => {
      const history = historyOf([record('https://fine.example.com/')], {
        falsePositives: {
          'https://fine.example.com/': {
            url: 'https://fine.example.com/',
            reportedBy: 'octocat',
            reportedAt: SCANNED_AT,
          },
        },
      });
      const report = renderLinkReport(history);
      const lines = report.split('\n');
      const suppressedHeader = lineIndex(report, '## Suppressed false positives');
      expect(lines[suppressedHeader + 2]).toBe('None.');
      expect(report).toContain('| 1 | 1 | 0 | 0 | 0 |');
    });

    it('suppresses failing links too', () => {
      const history = mixedHistory();
      history.falsePositives = {
        'https://flaky.example.com/?a=1|b=2': {
          url: 'https://flaky.example.com/?a=1|b=2',
          reportedBy: 'octocat',
          reportedAt: SCANNED_AT,
        },
      };
      const report = renderLinkReport(history);
      const lines = report.split('\n');
      const failingHeader = lineIndex(report, '## Failing (not yet confirmed broken)');
      expect(lines[failingHeader + 2]).toBe('None.');
      expect(report).toContain('| 5 | 1 | 0 | 3 | 1 |');
    });
  });

  describe('broken table ordering (longest dead first)', () => {
    it('puts never-worked links before dated ones, then sorts by oldest lastOkAt', () => {
      const report = renderLinkReport(mixedHistory());
      const lines = report.split('\n');
      const never = lines.findIndex((l) => l.startsWith('| https://never.example.com/'));
      const old = lines.findIndex((l) => l.startsWith('| https://old.example.com/'));
      const recent = lines.findIndex((l) => l.startsWith('| https://recent.example.com/'));
      expect(never).toBeGreaterThan(-1);
      expect(never).toBeLessThan(old);
      expect(old).toBeLessThan(recent);
    });

    it('breaks ties between never-worked links alphabetically by URL', () => {
      const report = renderLinkReport(
        historyOf([
          record('https://zzz.example.com/', {
            state: 'broken',
            lastOkAt: null,
            lastStatusCode: null,
            consecutiveFailures: 3,
          }),
          record('https://aaa.example.com/', {
            state: 'broken',
            lastOkAt: null,
            lastStatusCode: null,
            consecutiveFailures: 3,
          }),
        ]),
      );
      const lines = report.split('\n');
      const a = lines.findIndex((l) => l.startsWith('| https://aaa.example.com/'));
      const z = lines.findIndex((l) => l.startsWith('| https://zzz.example.com/'));
      expect(a).toBeGreaterThan(-1);
      expect(a).toBeLessThan(z);
    });

    it('breaks ties between identical lastOkAt values alphabetically by URL', () => {
      const dead = '2026-01-10T00:00:00.000Z';
      const report = renderLinkReport(
        historyOf([
          record('https://beta.example.com/', {
            state: 'broken',
            lastOkAt: dead,
            lastStatusCode: 404,
            consecutiveFailures: 5,
          }),
          record('https://alpha.example.com/', {
            state: 'broken',
            lastOkAt: dead,
            lastStatusCode: 404,
            consecutiveFailures: 5,
          }),
        ]),
      );
      const lines = report.split('\n');
      const alpha = lines.findIndex((l) => l.startsWith('| https://alpha.example.com/'));
      const beta = lines.findIndex((l) => l.startsWith('| https://beta.example.com/'));
      expect(alpha).toBeGreaterThan(-1);
      expect(alpha).toBeLessThan(beta);
    });
  });

  describe('never seen working phrasing', () => {
    it('uses "never seen working (first seen ...)" with the formatted firstSeenAt', () => {
      const report = renderLinkReport(
        historyOf([
          record('https://dead.example.com/', {
            state: 'broken',
            firstSeenAt: '2026-02-01T00:00:00.000Z',
            lastOkAt: null,
            lastStatusCode: null,
            consecutiveFailures: 9,
          }),
        ]),
      );
      expect(report).toContain('never seen working (first seen 2026-02-01T00:00:00Z)');
    });

    it('never uses the phrase when every link has a lastOkAt', () => {
      const report = renderLinkReport(
        historyOf([
          record('https://was-ok.example.com/', {
            state: 'broken',
            lastOkAt: '2026-01-02T03:04:05.000Z',
            lastStatusCode: 410,
            consecutiveFailures: 3,
          }),
        ]),
      );
      expect(report).not.toContain('never seen working');
      expect(report).toContain('2026-01-02T03:04:05Z');
    });
  });

  describe('failing section', () => {
    it('lists failing links in their own table, alphabetically', () => {
      const report = renderLinkReport(
        historyOf([
          record('https://second.example.com/', {
            state: 'failing',
            lastOkAt: '2026-03-01T00:00:00.000Z',
            lastStatusCode: 502,
            consecutiveFailures: 2,
          }),
          record('https://first.example.com/', {
            state: 'failing',
            lastOkAt: '2026-01-01T00:00:00.000Z',
            lastStatusCode: 500,
            consecutiveFailures: 1,
          }),
        ]),
      );
      const lines = report.split('\n');
      const header = lineIndex(report, '## Failing (not yet confirmed broken)');
      const first = lines.findIndex((l) => l.startsWith('| https://first.example.com/'));
      const second = lines.findIndex((l) => l.startsWith('| https://second.example.com/'));
      // Alphabetical even though "second" has the older lastOkAt.
      expect(first).toBeGreaterThan(header);
      expect(first).toBeLessThan(second);
    });

    it('shows "None." under both Broken and Failing when everything is ok', () => {
      const report = renderLinkReport(historyOf([record('https://fine.example.com/')]));
      const lines = report.split('\n');
      const brokenHeader = lineIndex(report, '## Broken links');
      const failingHeader = lineIndex(report, '## Failing (not yet confirmed broken)');
      expect(lines[brokenHeader + 2]).toBe('None.');
      expect(lines[failingHeader + 2]).toBe('None.');
    });
  });

  describe('details appendix', () => {
    it('wraps all tracked links in a collapsed <details> block with a count', () => {
      const report = renderLinkReport(mixedHistory());
      const open = lineIndex(report, '<details>');
      const summaryLine = lineIndex(report, '<summary>All tracked links (5)</summary>');
      const close = lineIndex(report, '</details>');
      expect(open).toBeLessThan(summaryLine);
      expect(summaryLine).toBeLessThan(close);
    });

    it('lists every link alphabetically with state and last-worked info', () => {
      const report = renderLinkReport(mixedHistory());
      const appendix = report.slice(report.indexOf('<details>'));
      const rows = appendix
        .split('\n')
        .filter((l) => l.startsWith('| https://'))
        .map((l) => l.split(' ')[1]);
      expect(rows).toEqual([
        'https://flaky.example.com/?a=1\\|b=2',
        'https://never.example.com/',
        'https://ok.example.com/',
        'https://old.example.com/',
        'https://recent.example.com/',
      ]);
      expect(appendix).toContain('| https://ok.example.com/ | ok | 2026-03-05T12:00:00Z |');
    });
  });

  describe('occurrences cell', () => {
    function reportWithOccurrences(occurrences: LinkRecord['occurrences']): string {
      return renderLinkReport(
        historyOf([
          record('https://x.example.com/', {
            state: 'broken',
            lastOkAt: null,
            lastStatusCode: 404,
            consecutiveFailures: 3,
            occurrences,
          }),
        ]),
      );
    }

    it('shows all occurrences when there are exactly three, with no "+N more"', () => {
      const report = reportWithOccurrences([
        { file: 'f1.md', line: 1 },
        { file: 'f2.md', line: 2 },
        { file: 'f3.md', line: 3 },
      ]);
      expect(report).toContain('`f1.md:1`, `f2.md:2`, `f3.md:3` |');
      expect(report).not.toContain('more');
    });

    it('truncates to three and appends "+N more" for longer lists', () => {
      const report = reportWithOccurrences([
        { file: 'f1.md', line: 1 },
        { file: 'f2.md', line: 2 },
        { file: 'f3.md', line: 3 },
        { file: 'f4.md', line: 4 },
        { file: 'f5.md', line: 5 },
      ]);
      expect(report).toContain('`f1.md:1`, `f2.md:2`, `f3.md:3` +2 more');
      expect(report).not.toContain('f4.md');
      expect(report).not.toContain('f5.md');
    });

    it('renders an em dash when a link has no occurrences', () => {
      const report = reportWithOccurrences([]);
      expect(report).toContain(`| ${EM_DASH} |`);
    });
  });

  describe('pipe escaping', () => {
    it('escapes pipes in URLs in every table so Markdown cells stay intact', () => {
      const url = 'https://pipes.example.com/?x=a|b|c';
      const report = renderLinkReport(
        historyOf([
          record(url, {
            state: 'broken',
            lastOkAt: null,
            lastStatusCode: null,
            consecutiveFailures: 3,
            occurrences: [{ file: 'weird|name.md', line: 5 }],
          }),
        ]),
      );
      const escapedUrl = 'https://pipes.example.com/?x=a\\|b\\|c';
      // Once in the broken table, once in the appendix.
      expect(report.split(escapedUrl)).toHaveLength(3);
      expect(report).toContain('`weird\\|name.md:5`');
      // The raw URL (unescaped pipes) must never appear.
      expect(report).not.toContain(url);
    });
  });

  describe('timestamp formatting', () => {
    it('strips milliseconds from ISO timestamps', () => {
      const report = renderLinkReport(historyOf([], { updatedAt: '2026-03-05T12:00:00.123Z' }));
      expect(report).toContain('Scanned at 2026-03-05T12:00:00Z.');
      expect(report).not.toContain('.123Z');
    });

    it('normalizes timestamps that already lack milliseconds', () => {
      const report = renderLinkReport(historyOf([], { updatedAt: '2026-03-05T12:00:00Z' }));
      expect(report).toContain('Scanned at 2026-03-05T12:00:00Z.');
    });
  });

  describe('stability', () => {
    it('produces byte-for-byte identical output for the same input rendered twice', () => {
      const first = renderLinkReport(mixedHistory());
      const second = renderLinkReport(structuredClone(mixedHistory()));
      expect(second).toBe(first);
    });

    it('is independent of link insertion order', () => {
      const forward = mixedHistory();
      const reversed: RepoLinkHistory = {
        repo: forward.repo,
        updatedAt: forward.updatedAt,
        links: Object.fromEntries(Object.entries(forward.links).reverse()),
      };
      expect(renderLinkReport(reversed)).toBe(renderLinkReport(forward));
    });
  });
});

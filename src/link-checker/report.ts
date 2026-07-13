import type {
  FalsePositiveReport,
  LinkRecord,
  LinkReportSummary,
  RepoLinkHistory,
} from '../types.js';

const MAX_OCCURRENCES_SHOWN = 3;
const EMPTY_CELL = '—';

/**
 * Whether this record's failures are hidden by a false-positive report.
 * Only failing/broken links are suppressed — a marked link that is currently
 * ok counts as ok, and the mark lies dormant until it fails again.
 */
function isSuppressed(history: RepoLinkHistory, record: LinkRecord): boolean {
  return record.state !== 'ok' && history.falsePositives?.[record.url] !== undefined;
}

/** Count links by state; suppressed false positives are counted separately. */
export function summarize(history: RepoLinkHistory): LinkReportSummary {
  const summary: LinkReportSummary = { total: 0, ok: 0, failing: 0, broken: 0, suppressed: 0 };
  for (const record of Object.values(history.links)) {
    summary.total += 1;
    if (isSuppressed(history, record)) {
      summary.suppressed += 1;
    } else {
      summary[record.state] += 1;
    }
  }
  return summary;
}

/**
 * Render the Markdown link-health report for one repo.
 *
 * Behavior contract:
 * - Header with repo name and scan date, then a summary line/table
 *   (total / ok / failing / broken).
 * - "Broken links" table: URL, last status, **last time it worked**
 *   (lastOkAt, or "never seen working"), first seen, consecutive failures,
 *   and where it appears (file:line list, truncated if long).
 * - "Failing (not yet confirmed broken)" table for links under the threshold.
 * - "Suppressed false positives" table: failing/broken links hidden because a
 *   human reported them (via a `/false-positive <url>` comment on the report
 *   issue), with who reported them and when.
 * - A collapsed <details> appendix listing every tracked link with lastOkAt.
 * - A footer explaining the false-positive commands.
 * - Deterministic ordering (broken sorted by lastOkAt ascending — longest-dead
 *   first; others alphabetical). Output must be stable for identical input so
 *   issue updates don't churn.
 */
export function renderLinkReport(history: RepoLinkHistory): string {
  const summary = summarize(history);
  const records = Object.values(history.links);
  const broken = records
    .filter((r) => r.state === 'broken' && !isSuppressed(history, r))
    .sort(byLongestDead);
  const failing = records
    .filter((r) => r.state === 'failing' && !isSuppressed(history, r))
    .sort(byUrl);
  const suppressed = records.filter((r) => isSuppressed(history, r)).sort(byUrl);
  const all = [...records].sort(byUrl);

  const lines: string[] = [
    `# Link health report for ${history.repo}`,
    '',
    `Scanned at ${formatTimestamp(history.updatedAt)}.`,
    '',
    '| Total | OK | Failing | Broken | Suppressed |',
    '| ---: | ---: | ---: | ---: | ---: |',
    `| ${summary.total} | ${summary.ok} | ${summary.failing} | ${summary.broken} | ${summary.suppressed} |`,
    '',
    '## Broken links',
    '',
  ];

  if (broken.length === 0) {
    lines.push('None.');
  } else {
    lines.push(
      '| URL | Last status | Last worked | First seen | Consecutive failures | Found in |',
      '| --- | --- | --- | --- | ---: | --- |',
      ...broken.map(
        (r) =>
          `| ${escapeCell(r.url)} | ${statusCell(r)} | ${lastWorkedCell(r)} | ` +
          `${formatTimestamp(r.firstSeenAt)} | ${r.consecutiveFailures} | ${occurrencesCell(r)} |`,
      ),
    );
  }

  lines.push('', '## Failing (not yet confirmed broken)', '');
  if (failing.length === 0) {
    lines.push('None.');
  } else {
    lines.push(
      '| URL | Last status | Last worked | Consecutive failures | Found in |',
      '| --- | --- | --- | ---: | --- |',
      ...failing.map(
        (r) =>
          `| ${escapeCell(r.url)} | ${statusCell(r)} | ${lastWorkedCell(r)} | ` +
          `${r.consecutiveFailures} | ${occurrencesCell(r)} |`,
      ),
    );
  }

  lines.push('', '## Suppressed false positives', '');
  if (suppressed.length === 0) {
    lines.push('None.');
  } else {
    lines.push(
      '| URL | State | Last status | Reported by | Reported at |',
      '| --- | --- | --- | --- | --- |',
      ...suppressed.map((r) => {
        const report = history.falsePositives?.[r.url];
        return (
          `| ${escapeCell(r.url)} | ${r.state} | ${statusCell(r)} | ` +
          `${reporterCell(report)} | ${report ? formatTimestamp(report.reportedAt) : EMPTY_CELL} |`
        );
      }),
    );
  }

  lines.push('', '<details>', `<summary>All tracked links (${summary.total})</summary>`, '');
  if (all.length === 0) {
    lines.push('None.');
  } else {
    lines.push(
      '| URL | State | Last worked |',
      '| --- | --- | --- |',
      ...all.map((r) => `| ${escapeCell(r.url)} | ${r.state} | ${lastWorkedCell(r)} |`),
    );
  }
  lines.push(
    '',
    '</details>',
    '',
    '---',
    '',
    'Wrongly flagged link? Comment `/false-positive <url>` on this issue and the next',
    'scan stops reporting it as dead. Undo with `/not-false-positive <url>`.',
    '',
  );

  return lines.join('\n');
}

function reporterCell(report: FalsePositiveReport | undefined): string {
  if (!report) return EMPTY_CELL;
  const login = `@${escapeCell(report.reportedBy)}`;
  return report.commentUrl ? `[${login}](${report.commentUrl})` : login;
}

/** ISO date+time in UTC without milliseconds, e.g. 2026-02-01T09:30:15Z. */
function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function byUrl(a: LinkRecord, b: LinkRecord): number {
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

/** Longest-dead first: never-worked links, then oldest lastOkAt; URL breaks ties. */
function byLongestDead(a: LinkRecord, b: LinkRecord): number {
  const aOk = a.lastOkAt === null ? -Infinity : Date.parse(a.lastOkAt);
  const bOk = b.lastOkAt === null ? -Infinity : Date.parse(b.lastOkAt);
  if (aOk !== bOk) return aOk < bOk ? -1 : 1;
  return byUrl(a, b);
}

function lastWorkedCell(r: LinkRecord): string {
  if (r.lastOkAt === null) {
    return `never seen working (first seen ${formatTimestamp(r.firstSeenAt)})`;
  }
  return formatTimestamp(r.lastOkAt);
}

function statusCell(r: LinkRecord): string {
  return r.lastStatusCode === null ? EMPTY_CELL : String(r.lastStatusCode);
}

function occurrencesCell(r: LinkRecord): string {
  if (r.occurrences.length === 0) return EMPTY_CELL;
  const shown = r.occurrences
    .slice(0, MAX_OCCURRENCES_SHOWN)
    .map((o) => `\`${escapeCell(o.file)}:${o.line}\``);
  const extra = r.occurrences.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
}

/** Keep literal pipes from breaking Markdown table cells. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

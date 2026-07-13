/**
 * CLI entry: `npm run links` — loads repos.json, runs the link scan, prints a
 * per-repo result table, exits non-zero only on scanner errors (broken links
 * are report content, not a scanner failure).
 */
import { loadConfig } from './config.js';
import { runLinkScan } from './link-checker/index.js';

const config = await loadConfig();
const results = await runLinkScan(config);

if (results.length === 0) {
  console.log('No repos with links.enabled in repos.json — nothing to scan.');
} else {
  console.table(
    results.map((r) => ({
      repo: r.repo,
      total: r.summary.total,
      ok: r.summary.ok,
      failing: r.summary.failing,
      broken: r.summary.broken,
      suppressed: r.summary.suppressed,
      issue: r.issueUrl ?? '',
      emailed: r.emailedTo.join(', '),
      error: r.error ?? '',
    })),
  );
}

if (results.some((r) => r.error !== undefined)) {
  process.exitCode = 1;
}

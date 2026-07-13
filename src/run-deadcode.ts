/**
 * CLI entry: `npm run deadcode` — loads repos.json, runs the dead-code sweep,
 * prints a per-repo result table, exits non-zero only on scanner errors.
 */
import { loadConfig } from './config.js';
import { runDeadCodeScan } from './dead-code/index.js';

const config = await loadConfig();
const results = await runDeadCodeScan(config);

if (results.length === 0) {
  console.log('No repos with deadCode.enabled in repos.json — nothing to sweep.');
} else {
  console.table(
    results.map((r) => ({
      repo: r.repo,
      findings: r.findingCount,
      verified: r.verified === undefined ? '' : r.verified ? 'yes' : 'no',
      pr: r.prUrl ?? '',
      issue: r.issueUrl ?? '',
      error: r.error ?? '',
    })),
  );
}

if (results.some((r) => r.error !== undefined)) {
  process.exitCode = 1;
}

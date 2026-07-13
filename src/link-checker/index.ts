import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { JanitorConfig, LinkScanRunResult, RepoConfig } from '../types.js';
import { cloneRepo, getOctokit, parseRepo } from '../github.js';
import { emailConfigured, sendReportEmail } from '../reporting/email.js';
import { upsertReportIssue } from '../reporting/issue.js';
import { checkLinks } from './check.js';
import { extractLinks } from './extract.js';
import { loadHistory, mergeOutcomes, saveHistory } from './history.js';
import { renderLinkReport, summarize } from './report.js';

const ISSUE_TITLE = '🔗 Link health report';
const JANITOR_LABEL = 'repo-janitor';

export interface LinkScanOptions {
  /** Where history JSON lives (default 'data'). */
  dataDir?: string;
  /** Scratch dir for clones (default '.work'); cleaned per repo. */
  workDir?: string;
}

/**
 * Run the full link scan for every onboarded repo with links.enabled.
 *
 * Per repo: shallow-clone → extractLinks → checkLinks → mergeOutcomes with
 * prior history → saveHistory → renderLinkReport → upsertReportIssue in the
 * TARGET repo when report === 'issue' → sendReportEmail when recipients are
 * configured AND SMTP is set up. A failure in one repo is captured in that
 * repo's result (error field) and never aborts the others. Appends a summary
 * to GITHUB_STEP_SUMMARY when that env var is present.
 */
export async function runLinkScan(
  config: JanitorConfig,
  opts: LinkScanOptions = {},
): Promise<LinkScanRunResult[]> {
  const dataDir = opts.dataDir ?? 'data';
  const workDir = opts.workDir ?? '.work';

  const results: LinkScanRunResult[] = [];
  for (const repoConfig of config.repos) {
    if (!repoConfig.links.enabled) continue;
    results.push(await scanOneRepo(repoConfig, dataDir, workDir));
  }

  await appendStepSummary(results);
  return results;
}

async function scanOneRepo(
  repoConfig: RepoConfig,
  dataDir: string,
  workDir: string,
): Promise<LinkScanRunResult> {
  const result: LinkScanRunResult = {
    repo: repoConfig.repo,
    summary: { total: 0, ok: 0, failing: 0, broken: 0 },
    emailedTo: [],
  };

  const { owner, name } = parseRepo(repoConfig.repo);
  const repoDir = path.join(workDir, `${owner}__${name}`);

  try {
    await rm(repoDir, { recursive: true, force: true });
    await cloneRepo(repoConfig.repo, repoDir, { branch: repoConfig.branch, depth: 1 });

    const extracted = await extractLinks(repoDir, {
      ignoreUrlPatterns: repoConfig.links.ignoreUrlPatterns,
    });
    const outcomes = await checkLinks([...extracted.keys()]);
    const previous = await loadHistory(dataDir, repoConfig.repo);
    const history = mergeOutcomes(previous, repoConfig.repo, extracted, outcomes, {
      failThreshold: repoConfig.links.failThreshold,
    });

    result.historyPath = await saveHistory(dataDir, history);
    result.summary = summarize(history);
    const report = renderLinkReport(history);

    if (repoConfig.links.report === 'issue') {
      const issue = await upsertReportIssue(getOctokit(), repoConfig.repo, {
        title: ISSUE_TITLE,
        body: report,
        labels: [JANITOR_LABEL],
      });
      result.issueUrl = issue.url;
    }

    if (repoConfig.links.email.length > 0 && emailConfigured()) {
      const subject = `Link health: ${repoConfig.repo} — ${result.summary.broken} broken, ${result.summary.failing} failing`;
      const sent = await sendReportEmail(repoConfig.links.email, subject, report);
      if (sent) result.emailedTo = [...repoConfig.links.email];
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[link-scan] ${repoConfig.repo}: ${result.error}`);
  } finally {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }

  return result;
}

async function appendStepSummary(results: LinkScanRunResult[]): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || results.length === 0) return;

  const lines = [
    '## 🔗 Link scan',
    '',
    '| Repo | Total | OK | Failing | Broken | Report | Error |',
    '| --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const r of results) {
    const report = r.issueUrl ? `[issue](${r.issueUrl})` : '—';
    lines.push(
      `| ${r.repo} | ${r.summary.total} | ${r.summary.ok} | ${r.summary.failing} | ${r.summary.broken} | ${report} | ${mdCell(r.error)} |`,
    );
  }
  await appendFile(summaryPath, lines.join('\n') + '\n\n');
}

/** Error messages contain newlines and pipes (git output) that break table rows. */
function mdCell(text: string | undefined): string {
  if (!text) return '—';
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').slice(0, 300);
}

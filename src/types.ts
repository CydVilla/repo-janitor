/**
 * Shared contracts for repo-janitor.
 *
 * Every module imports its cross-module types from here. This file is
 * dependency-free and is the single source of truth for data shapes that
 * cross module boundaries.
 */

// ---------------------------------------------------------------------------
// Configuration (repos.json, after defaults are applied by src/config.ts)
// ---------------------------------------------------------------------------

export interface JanitorConfig {
  repos: RepoConfig[];
}

export interface RepoConfig {
  /** "owner/name" */
  repo: string;
  /** Branch to scan; when omitted, the repo's default branch is used. */
  branch?: string;
  links: LinkFeatureConfig;
  deadCode: DeadCodeFeatureConfig;
}

export interface LinkFeatureConfig {
  enabled: boolean;
  /** 'issue' upserts a report issue in the target repo; 'none' only stores history. */
  report: 'issue' | 'none';
  /** Optional email recipients; only used when SMTP secrets are configured. */
  email: string[];
  /** Extra regex source strings; URLs matching any pattern are never checked. */
  ignoreUrlPatterns: string[];
  /** Consecutive failed scans before a link is considered broken (default 3). */
  failThreshold: number;
}

export interface DeadCodeFeatureConfig {
  enabled: boolean;
  /** When false, findings are reported as an issue instead of opening a PR. */
  openPRs: boolean;
  /** Values passed to `knip --fix-type` (default: exports, types). */
  fixTypes: string[];
  /** Overrides auto-detected verify commands (package.json typecheck/build/test scripts). */
  verifyCommands?: string[];
}

// ---------------------------------------------------------------------------
// Link scanning
// ---------------------------------------------------------------------------

export interface LinkOccurrence {
  /** Path relative to the scanned repo root. */
  file: string;
  /** 1-based line number. */
  line: number;
}

export interface LinkCheckOutcome {
  url: string;
  ok: boolean;
  statusCode?: number;
  /** Final URL when the response permanently redirected elsewhere. */
  redirectedTo?: string;
  error?: string;
  durationMs: number;
  /** ISO timestamp. */
  checkedAt: string;
}

export type LinkState = 'ok' | 'failing' | 'broken';

export interface LinkHistoryEntry {
  /** ISO timestamp. */
  at: string;
  ok: boolean;
  statusCode?: number;
}

export interface LinkRecord {
  url: string;
  state: LinkState;
  firstSeenAt: string;
  lastCheckedAt: string;
  /**
   * Null when the link has never been observed working.
   * This is the "last time this link worked" metric.
   */
  lastOkAt: string | null;
  lastStatusCode: number | null;
  consecutiveFailures: number;
  totalChecks: number;
  totalFailures: number;
  redirectedTo?: string;
  occurrences: LinkOccurrence[];
  /** Recent check results, newest last, capped (default 50). */
  history: LinkHistoryEntry[];
}

export interface RepoLinkHistory {
  repo: string;
  updatedAt: string;
  links: Record<string, LinkRecord>;
  /**
   * URLs reported as false positives (keyed by URL). A marked link is still
   * checked and tracked, but its failures are suppressed from the report's
   * broken/failing sections until the mark is removed.
   */
  falsePositives?: Record<string, FalsePositiveReport>;
}

/** A human report that a link is wrongly flagged, read from issue comments. */
export interface FalsePositiveReport {
  url: string;
  /** GitHub login of the comment author. */
  reportedBy: string;
  /** ISO timestamp of the comment. */
  reportedAt: string;
  /** Link to the comment carrying the directive, when known. */
  commentUrl?: string;
}

export interface LinkReportSummary {
  total: number;
  ok: number;
  failing: number;
  broken: number;
  /** Failing/broken links hidden because they were reported as false positives. */
  suppressed: number;
}

// ---------------------------------------------------------------------------
// Dead code
// ---------------------------------------------------------------------------

export type DeadCodeCategory =
  | 'unused-file'
  | 'unused-export'
  | 'unused-type'
  | 'unused-enum-member'
  | 'unused-class-member'
  | 'unused-dependency'
  | 'unlisted-dependency'
  | 'unresolved-import'
  | 'duplicate-export'
  | 'other';

export interface DeadCodeFinding {
  category: DeadCodeCategory;
  /** Path relative to the scanned repo root. */
  file: string;
  /** Symbol / dependency name when applicable. */
  name?: string;
  line?: number;
  col?: number;
}

// ---------------------------------------------------------------------------
// Orchestrator results
// ---------------------------------------------------------------------------

export interface LinkScanRunResult {
  repo: string;
  summary: LinkReportSummary;
  historyPath?: string;
  issueUrl?: string;
  emailedTo: string[];
  error?: string;
}

export interface DeadCodeRunResult {
  repo: string;
  findingCount: number;
  prUrl?: string;
  issueUrl?: string;
  /** Whether verify commands passed after applying fixes. */
  verified?: boolean;
  error?: string;
}

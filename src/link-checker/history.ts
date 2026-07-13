import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  LinkCheckOutcome,
  LinkHistoryEntry,
  LinkOccurrence,
  LinkRecord,
  RepoLinkHistory,
} from '../types.js';

const DEFAULT_FAIL_THRESHOLD = 3;
const DEFAULT_MAX_HISTORY_ENTRIES = 50;

export interface MergeOptions {
  /** Consecutive failures before a link is 'broken' (default 3). */
  failThreshold?: number;
  /** Cap on per-link history entries (default 50). */
  maxHistoryEntries?: number;
  /** ISO timestamp override for tests; defaults to now. */
  now?: string;
}

/**
 * Merge one scan into the persisted history.
 *
 * Behavior contract (the state machine at the heart of the product):
 * - New URL: firstSeenAt = now; ok → state 'ok'; fail → 'failing' (or 'broken'
 *   if threshold is 1).
 * - Successful check: state 'ok', consecutiveFailures reset to 0, lastOkAt = now.
 * - Failed check: consecutiveFailures + 1; state 'failing' while below
 *   failThreshold, 'broken' at/above it. lastOkAt is preserved untouched —
 *   it is the "last time this link worked" metric.
 * - totalChecks/totalFailures increment accordingly; lastStatusCode and
 *   redirectedTo reflect the latest outcome; occurrences are replaced with the
 *   freshly extracted ones; a LinkHistoryEntry is appended (capped, newest last).
 * - URLs present in `previous` but absent from `extracted` were removed from
 *   the repo: drop them from the result.
 * - A URL in `extracted` with no outcome this run (e.g. skipped) keeps its
 *   previous record but with updated occurrences.
 */
export function mergeOutcomes(
  previous: RepoLinkHistory | null,
  repo: string,
  extracted: Map<string, LinkOccurrence[]>,
  outcomes: LinkCheckOutcome[],
  options: MergeOptions = {},
): RepoLinkHistory {
  const resolved: ResolvedMergeOptions = {
    failThreshold: options.failThreshold ?? DEFAULT_FAIL_THRESHOLD,
    maxHistoryEntries: options.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES,
    now: options.now ?? new Date().toISOString(),
  };
  const outcomeByUrl = new Map(outcomes.map((outcome) => [outcome.url, outcome]));
  const links: Record<string, LinkRecord> = {};

  for (const [url, occurrences] of extracted) {
    const prev = previous?.links[url];
    const outcome = outcomeByUrl.get(url);
    if (outcome) {
      links[url] = applyOutcome(prev, outcome, [...occurrences], resolved);
    } else if (prev) {
      // Skipped this run (e.g. matched an ignore pattern): keep the record,
      // only refresh where the link appears. A brand-new URL that was never
      // checked has no record to keep, so it stays untracked for now.
      links[url] = { ...prev, occurrences: [...occurrences] };
    }
  }

  return { repo, updatedAt: resolved.now, links };
}

interface ResolvedMergeOptions {
  failThreshold: number;
  maxHistoryEntries: number;
  now: string;
}

function applyOutcome(
  prev: LinkRecord | undefined,
  outcome: LinkCheckOutcome,
  occurrences: LinkOccurrence[],
  opts: ResolvedMergeOptions,
): LinkRecord {
  const consecutiveFailures = outcome.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;

  const entry: LinkHistoryEntry = { at: outcome.checkedAt, ok: outcome.ok };
  if (outcome.statusCode !== undefined) entry.statusCode = outcome.statusCode;

  const record: LinkRecord = {
    url: outcome.url,
    state: outcome.ok
      ? 'ok'
      : consecutiveFailures >= opts.failThreshold
        ? 'broken'
        : 'failing',
    firstSeenAt: prev?.firstSeenAt ?? opts.now,
    lastCheckedAt: opts.now,
    lastOkAt: outcome.ok ? opts.now : (prev?.lastOkAt ?? null),
    lastStatusCode: outcome.statusCode ?? null,
    consecutiveFailures,
    totalChecks: (prev?.totalChecks ?? 0) + 1,
    totalFailures: (prev?.totalFailures ?? 0) + (outcome.ok ? 0 : 1),
    occurrences,
    history: [...(prev?.history ?? []), entry].slice(-opts.maxHistoryEntries),
  };
  if (outcome.redirectedTo !== undefined) record.redirectedTo = outcome.redirectedTo;
  return record;
}

function sanitizePathPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_.-]/g, '-');
}

/** data/links/<owner>__<name>.json (owner/name sanitized for the filesystem). */
export function historyFilePath(dataDir: string, repo: string): string {
  const slash = repo.indexOf('/');
  const owner = slash === -1 ? '' : repo.slice(0, slash);
  const name = slash === -1 ? repo : repo.slice(slash + 1);
  return path.join(dataDir, 'links', `${sanitizePathPart(owner)}__${sanitizePathPart(name)}.json`);
}

/** Returns null when no history file exists yet. */
export async function loadHistory(dataDir: string, repo: string): Promise<RepoLinkHistory | null> {
  const filePath = historyFilePath(dataDir, repo);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as RepoLinkHistory;
  } catch (err) {
    throw new Error(`Corrupt link history file ${filePath}: ${(err as Error).message}`);
  }
}

/** Writes pretty-printed JSON (stable key order), creating directories as needed. Returns the file path. */
export async function saveHistory(dataDir: string, history: RepoLinkHistory): Promise<string> {
  const filePath = historyFilePath(dataDir, history.repo);

  // The file is committed to git; alphabetical link keys keep diffs minimal.
  const links: Record<string, LinkRecord> = {};
  for (const url of Object.keys(history.links).sort()) {
    const record = history.links[url];
    if (record) links[url] = record;
  }
  const stable: RepoLinkHistory = { repo: history.repo, updatedAt: history.updatedAt, links };
  if (history.falsePositives && Object.keys(history.falsePositives).length > 0) {
    const falsePositives: NonNullable<RepoLinkHistory['falsePositives']> = {};
    for (const url of Object.keys(history.falsePositives).sort()) {
      const report = history.falsePositives[url];
      if (report) falsePositives[url] = report;
    }
    stable.falsePositives = falsePositives;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stable, null, 2)}\n`, 'utf8');
  return filePath;
}

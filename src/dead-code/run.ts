import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeadCodeCategory, DeadCodeFinding } from '../types.js';
import { excerpt, execCommand, scrubbedEnv, type CommandOptions } from './exec.js';

export interface KnipRunResult {
  findings: DeadCodeFinding[];
  /** Set when knip itself failed to run (as opposed to reporting findings). */
  knipError?: string;
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const KNIP_TIMEOUT_MS = 10 * 60_000;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Lockfile-based detection: pnpm-lock.yaml → pnpm, yarn.lock → yarn, else npm. */
export async function detectPackageManager(repoDir: string): Promise<PackageManager> {
  if (await exists(path.join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(repoDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** Yarn 2+ ("Berry"): .yarnrc.yml or a packageManager field pinning yarn@2+. */
async function isYarnBerry(repoDir: string): Promise<boolean> {
  if (await exists(path.join(repoDir, '.yarnrc.yml'))) return true;
  try {
    const raw = await readFile(path.join(repoDir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const pm =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).packageManager
        : undefined;
    const match = typeof pm === 'string' ? /^yarn@(\d+)/.exec(pm) : null;
    return match !== null && Number(match[1]) >= 2;
  } catch {
    return false;
  }
}

/**
 * Install the target repo's dependencies so knip can resolve its module graph.
 * Detects the package manager from lockfiles (pnpm-lock.yaml → pnpm,
 * yarn.lock → yarn, otherwise npm; prefer `npm ci` when package-lock.json
 * exists). Uses execFile-style invocation (no shell), inherits a sane env,
 * and disables lifecycle scripts (--ignore-scripts) for safety.
 */
export async function installDependencies(repoDir: string): Promise<void> {
  const pm = await detectPackageManager(repoDir);

  let cmd: string;
  let args: string[];
  const opts: CommandOptions = { cwd: repoDir, timeoutMs: INSTALL_TIMEOUT_MS };
  if (pm === 'pnpm') {
    cmd = 'pnpm';
    args = ['install', '--frozen-lockfile', '--ignore-scripts'];
  } else if (pm === 'yarn') {
    cmd = 'yarn';
    if (await isYarnBerry(repoDir)) {
      // Berry rejects the classic flags; scripts are disabled via env instead.
      args = ['install', '--immutable'];
      opts.env = { ...scrubbedEnv(), YARN_ENABLE_SCRIPTS: '0' };
    } else {
      args = ['install', '--frozen-lockfile', '--ignore-scripts'];
    }
  } else if (await exists(path.join(repoDir, 'package-lock.json'))) {
    cmd = 'npm';
    args = ['ci', '--ignore-scripts'];
  } else {
    cmd = 'npm';
    args = ['install', '--ignore-scripts'];
  }

  const result = await execCommand(cmd, args, opts);
  if (result.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (exit ${result.code}): ${excerpt(result.stderr || result.stdout)}`,
    );
  }
}

/**
 * Run knip in the target repo: `npx --yes knip@5 --reporter json` (plus
 * --no-exit-code so findings don't look like crashes), parse its JSON output
 * and map issues to DeadCodeFinding records:
 * files → unused-file; exports → unused-export; types/nsTypes → unused-type;
 * enumMembers → unused-enum-member; classMembers → unused-class-member;
 * dependencies/devDependencies → unused-dependency; unlisted →
 * unlisted-dependency; unresolved → unresolved-import; duplicates →
 * duplicate-export; anything else → other.
 */
export async function runKnip(repoDir: string): Promise<KnipRunResult> {
  const args = ['--yes', 'knip@5', '--reporter', 'json', '--no-exit-code'];
  const result = await execCommand('npx', args, { cwd: repoDir, timeoutMs: KNIP_TIMEOUT_MS });

  if (result.code !== 0) {
    return {
      findings: [],
      knipError: `knip exited with code ${result.code}: ${excerpt(result.stderr || result.stdout)}`,
    };
  }

  const parsed = parseKnipJson(result.stdout);
  if (parsed === undefined) {
    return {
      findings: [],
      knipError: `could not parse knip JSON output: ${excerpt(result.stderr || result.stdout, 300)}`,
    };
  }

  return { findings: mapKnipReport(parsed) };
}

/** Parse knip stdout defensively; tolerates npx noise around the JSON document. */
function parseKnipJson(stdout: string): Record<string, unknown> | undefined {
  for (const candidate of jsonCandidates(stdout)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function* jsonCandidates(stdout: string): Generator<string> {
  yield stdout;
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first !== -1 && last > first) yield stdout.slice(first, last + 1);
}

// ---------------------------------------------------------------------------
// Knip v5 JSON → DeadCodeFinding mapping
// ---------------------------------------------------------------------------

/** Flat issue arrays: [{ name, line?, col? }] (or plain strings). */
const FLAT_CATEGORY: Record<string, DeadCodeCategory> = {
  exports: 'unused-export',
  nsExports: 'unused-export',
  types: 'unused-type',
  nsTypes: 'unused-type',
  dependencies: 'unused-dependency',
  devDependencies: 'unused-dependency',
  unlisted: 'unlisted-dependency',
  unresolved: 'unresolved-import',
};

/** Nested issue records: { Parent: [{ name, line?, col? }] }. */
const NESTED_CATEGORY: Record<string, DeadCodeCategory> = {
  enumMembers: 'unused-enum-member',
  classMembers: 'unused-class-member',
};

/** Issue-object keys that are metadata, never findings. */
const NON_ISSUE_KEYS = new Set(['file', 'owners']);

function mapKnipReport(report: Record<string, unknown>): DeadCodeFinding[] {
  const findings: DeadCodeFinding[] = [];

  for (const file of asArray(report.files)) {
    if (typeof file === 'string' && file.length > 0) {
      findings.push({ category: 'unused-file', file });
    }
  }

  for (const issue of asArray(report.issues)) {
    mapIssue(issue, findings);
  }

  return findings;
}

function mapIssue(issue: unknown, findings: DeadCodeFinding[]): void {
  if (typeof issue !== 'object' || issue === null) return;
  const record = issue as Record<string, unknown>;
  const file = typeof record.file === 'string' ? record.file : '(unknown)';

  for (const [key, value] of Object.entries(record)) {
    if (NON_ISSUE_KEYS.has(key)) continue;

    const nested = NESTED_CATEGORY[key];
    if (nested) {
      mapNested(nested, file, value, findings);
      continue;
    }

    if (key === 'duplicates') {
      for (const group of asArray(value)) {
        pushSymbols('duplicate-export', file, asArray(group), findings);
      }
      continue;
    }

    if (!Array.isArray(value)) continue;
    pushSymbols(FLAT_CATEGORY[key] ?? 'other', file, value, findings);
  }
}

function mapNested(
  category: DeadCodeCategory,
  file: string,
  value: unknown,
  findings: DeadCodeFinding[],
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  for (const [parent, members] of Object.entries(value as Record<string, unknown>)) {
    for (const entry of asArray(members)) {
      const symbol = toSymbol(entry);
      if (!symbol) continue;
      findings.push({
        category,
        file,
        name: symbol.name ? `${parent}.${symbol.name}` : parent,
        line: symbol.line,
        col: symbol.col,
      });
    }
  }
}

function pushSymbols(
  category: DeadCodeCategory,
  file: string,
  entries: unknown[],
  findings: DeadCodeFinding[],
): void {
  for (const entry of entries) {
    const symbol = toSymbol(entry);
    if (!symbol) continue;
    findings.push({ category, file, name: symbol.name, line: symbol.line, col: symbol.col });
  }
}

function toSymbol(value: unknown): { name?: string; line?: number; col?: number } | null {
  if (typeof value === 'string') {
    return value.length > 0 ? { name: value } : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined;
  const line = typeof record.line === 'number' ? record.line : undefined;
  const col = typeof record.col === 'number' ? record.col : undefined;
  if (name === undefined && line === undefined) return null;
  return { name, line, col };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

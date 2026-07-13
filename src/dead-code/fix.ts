import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { excerpt, execCommand } from './exec.js';
import { detectPackageManager } from './run.js';

export interface FixResult {
  /** Whether knip --fix changed anything. */
  applied: boolean;
  /** Whether verify commands passed afterwards (true when nothing to verify). */
  verified: boolean;
  changedFiles: string[];
  /** Human-readable log lines of what ran and what happened. */
  log: string[];
}

const DEFAULT_FIX_TYPES = ['exports', 'types'];
const KNIP_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 15 * 60_000;
const GIT_TIMEOUT_MS = 60_000;

/** Auto-detected verify scripts, in the order they should run. */
const VERIFY_SCRIPT_ORDER = ['typecheck', 'build', 'test'];

interface VerifyCommand {
  cmd: string;
  args: string[];
  display: string;
}

/**
 * Apply knip's automatic fixes inside the target repo working tree, then
 * verify the repo still builds.
 *
 * Behavior contract:
 * - Runs `npx --yes knip@5 --fix --fix-type <types>` (default exports,types —
 *   deliberately NOT files/dependencies; deleting whole files is too risky
 *   for auto-PRs).
 * - changedFiles from `git status --porcelain` inside repoDir.
 * - Verify commands: use opts.verifyCommands verbatim when given; otherwise
 *   auto-detect from the target's package.json scripts, in order:
 *   typecheck, build, test (each included only if present). Run each with
 *   the repo's package manager (`npm run <script>` etc.).
 * - If any verify command fails: revert everything (`git checkout -- .` +
 *   `git clean -fd`), return applied per what happened, verified false.
 * - Never throws for fix/verify failures; capture in log. execFile-style
 *   argument arrays only, no shell interpolation of config values.
 */
export async function applyKnipFixes(
  repoDir: string,
  opts: { fixTypes?: string[]; verifyCommands?: string[] } = {},
): Promise<FixResult> {
  const log: string[] = [];

  // Files already dirty before knip runs (e.g. a package-lock.json created by
  // installDependencies) are not knip's doing and must never reach the PR.
  const baseline = new Set(await listChangedFiles(repoDir, log));
  if (baseline.size > 0) {
    log.push(`ignoring ${baseline.size} file(s) already dirty before the fix (install artifacts)`);
  }

  const fixTypes = opts.fixTypes && opts.fixTypes.length > 0 ? opts.fixTypes : DEFAULT_FIX_TYPES;
  // --no-exit-code: remaining unfixable findings are expected, not a crash.
  const fixArgs = ['--yes', 'knip@5', '--fix', '--fix-type', fixTypes.join(','), '--no-exit-code'];
  const fixResult = await execCommand('npx', fixArgs, { cwd: repoDir, timeoutMs: KNIP_TIMEOUT_MS });
  log.push(`$ npx ${fixArgs.join(' ')} → exit ${fixResult.code}`);

  const changedFiles = (await listChangedFiles(repoDir, log)).filter(
    (file) => !baseline.has(file),
  );

  if (fixResult.code !== 0) {
    log.push(`knip --fix failed: ${excerpt(fixResult.stderr || fixResult.stdout)}`);
    if (changedFiles.length > 0) {
      log.push('reverting partial changes left behind by the failed fix');
      await revert(repoDir, log);
    }
    return { applied: false, verified: false, changedFiles: [], log };
  }

  if (changedFiles.length === 0) {
    log.push('knip --fix made no changes');
    return { applied: false, verified: true, changedFiles: [], log };
  }
  log.push(`knip --fix changed ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}`);

  const commands = await resolveVerifyCommands(repoDir, opts.verifyCommands, log);
  for (const command of commands) {
    const result = await execCommand(command.cmd, command.args, {
      cwd: repoDir,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    log.push(`$ ${command.display} → exit ${result.code}`);
    if (result.code !== 0) {
      log.push(`verification failed: ${excerpt(result.stderr || result.stdout)}`);
      await revert(repoDir, log);
      return { applied: true, verified: false, changedFiles, log };
    }
  }

  if (commands.length === 0) log.push('no verify commands found; skipping verification');
  return { applied: true, verified: true, changedFiles, log };
}

async function listChangedFiles(repoDir: string, log: string[]): Promise<string[]> {
  const status = await execCommand('git', ['status', '--porcelain'], {
    cwd: repoDir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (status.code !== 0) {
    log.push(`git status --porcelain failed (exit ${status.code}): ${excerpt(status.stderr)}`);
    return [];
  }
  return parsePorcelain(status.stdout);
}

function parsePorcelain(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0 || line.length < 4) continue;
    // 'XY <path>' — for renames the path part is '<old> -> <new>'.
    const entry = line.slice(3);
    const renamed = entry.includes(' -> ') ? entry.split(' -> ').pop() ?? entry : entry;
    const cleaned = renamed.replace(/^"(.*)"$/, '$1');
    if (cleaned.length > 0) files.push(cleaned);
  }
  return files;
}

async function resolveVerifyCommands(
  repoDir: string,
  verbatim: string[] | undefined,
  log: string[],
): Promise<VerifyCommand[]> {
  if (verbatim && verbatim.length > 0) {
    const commands: VerifyCommand[] = [];
    for (const raw of verbatim) {
      const parts = raw.trim().split(/\s+/).filter((part) => part.length > 0);
      const cmd = parts[0];
      if (!cmd) continue;
      commands.push({ cmd, args: parts.slice(1), display: parts.join(' ') });
    }
    return commands;
  }

  const scripts = await readScripts(repoDir, log);
  const pm = await detectPackageManager(repoDir);
  const commands: VerifyCommand[] = [];
  for (const script of VERIFY_SCRIPT_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(scripts, script)) continue;
    commands.push({ cmd: pm, args: ['run', script], display: `${pm} run ${script}` });
  }
  return commands;
}

async function readScripts(repoDir: string, log: string[]): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(repoDir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return {};
    return scripts as Record<string, unknown>;
  } catch (err) {
    log.push(`could not read package.json scripts: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

async function revert(repoDir: string, log: string[]): Promise<void> {
  const checkout = await execCommand('git', ['checkout', '--', '.'], {
    cwd: repoDir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  log.push(`$ git checkout -- . → exit ${checkout.code}`);
  const clean = await execCommand('git', ['clean', '-fd'], {
    cwd: repoDir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  log.push(`$ git clean -fd → exit ${clean.code}`);
}

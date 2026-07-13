import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: CommandOptions,
) => Promise<CommandResult>;

/**
 * Env vars that must never leak into processes running target-repo code
 * (knip loads the target's knip.config.ts, verify commands run its scripts).
 * Git auth never needs these either — the token travels via `-c
 * http.extraheader` arguments, not the environment.
 */
const SECRET_ENV_VARS = [
  'JANITOR_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
];

/** A copy of the environment with every janitor secret removed. */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of SECRET_ENV_VARS) delete env[name];
  return env;
}

const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
/** After a timeout kill, wait at most this long for 'close' before settling anyway. */
const POST_KILL_GRACE_MS = 2_000;

/**
 * Default runner: child_process.spawn — argument arrays, never a shell.
 * Resolves (never rejects) so callers deal with exit codes uniformly; spawn
 * failures and timeouts surface as code -1 with the cause appended to stderr.
 *
 * The child runs in its own process group (POSIX) so a timeout can kill the
 * whole tree — npx/npm intermediaries routinely leave grandchildren behind,
 * and a surviving grandchild holding our stdio pipes must not hang the sweep.
 */
export const runCommand: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? scrubbedEnv(),
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = (code: number, extra?: string): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        code,
        stdout,
        stderr: extra ? [stderr, extra].filter((part) => part.length > 0).join('\n') : stderr,
      });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });

    if (opts.timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        graceTimer = setTimeout(
          () => settle(-1, `timed out after ${opts.timeoutMs}ms`),
          POST_KILL_GRACE_MS,
        );
      }, opts.timeoutMs);
    }

    child.on('error', (err) => settle(-1, err.message));
    child.on('close', (code, signal) =>
      settle(
        code ?? -1,
        timedOut
          ? `timed out after ${opts.timeoutMs}ms`
          : signal
            ? `terminated by ${signal}`
            : undefined,
      ),
    );
  });

function killTree(child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean }): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // group already gone; fall through to a direct kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }
}

let activeRunner: CommandRunner = runCommand;

/** Indirection point every dead-code module goes through to spawn commands. */
export function execCommand(
  cmd: string,
  args: string[],
  opts: CommandOptions,
): Promise<CommandResult> {
  return activeRunner(cmd, args, opts);
}

/** Test seam: inject a fake runner; pass null to restore the real one. */
export function setCommandRunnerForTests(runner: CommandRunner | null): void {
  activeRunner = runner ?? runCommand;
}

/** First `max` characters of trimmed text, for compact error messages. */
export function excerpt(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

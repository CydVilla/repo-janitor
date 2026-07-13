import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  setCommandRunnerForTests,
  type CommandOptions,
  type CommandResult,
} from '../src/dead-code/exec.js';
import { applyKnipFixes } from '../src/dead-code/fix.js';

interface Call {
  cmd: string;
  args: string[];
  opts: CommandOptions;
}

function installRunner(script: (call: Call) => Partial<CommandResult> | undefined = () => ({})) {
  const calls: Call[] = [];
  setCommandRunnerForTests(async (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    return { code: 0, stdout: '', stderr: '', ...(script(call) ?? {}) };
  });
  return calls;
}

const isStatus = (c: Call) => c.cmd === 'git' && c.args[0] === 'status';
const isKnip = (c: Call) => c.cmd === 'npx';
const isRun = (c: Call) => c.args[0] === 'run';

/**
 * Per-status-call outputs in order (last one repeats): the first `git status`
 * is the pre-fix baseline, the second reflects the tree after knip --fix.
 */
function statusSeq(...outputs: string[]): (call: Call) => Partial<CommandResult> | undefined {
  let index = 0;
  return (call) => {
    if (!isStatus(call)) return undefined;
    const stdout = outputs[Math.min(index, outputs.length - 1)] ?? '';
    index += 1;
    return { stdout };
  };
}

const tempDirs: string[] = [];

async function makeRepoDir(
  opts: { scripts?: Record<string, string>; lockfiles?: string[] } = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'janitor-fix-'));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'target', scripts: opts.scripts ?? {} }),
  );
  for (const lockfile of opts.lockfiles ?? ['package-lock.json']) {
    await writeFile(path.join(dir, lockfile), '');
  }
  return dir;
}

afterEach(async () => {
  setCommandRunnerForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('applyKnipFixes', () => {
  it('runs knip --fix with default fix types, verifies, and reports changed files', async () => {
    const dir = await makeRepoDir({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } });
    const status = statusSeq('', ' M src/a.ts\n?? src/new.ts\n');
    const calls = installRunner((call) => status(call));

    const result = await applyKnipFixes(dir);

    const knip = calls.find(isKnip)!;
    expect(knip.args).toEqual([
      '--yes',
      'knip@5',
      '--fix',
      '--fix-type',
      'exports,types',
      '--no-exit-code',
    ]);
    expect(knip.opts.cwd).toBe(dir);

    // baseline status runs before knip, the post-fix status after it
    expect(calls.findIndex(isStatus)).toBeLessThan(calls.findIndex(isKnip));
    expect(calls.filter(isStatus).length).toBe(2);

    // auto-detected verify scripts in order: typecheck, then test (no build script).
    expect(calls.filter(isRun).map((c) => [c.cmd, ...c.args])).toEqual([
      ['npm', 'run', 'typecheck'],
      ['npm', 'run', 'test'],
    ]);

    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.changedFiles).toEqual(['src/a.ts', 'src/new.ts']);
    expect(result.log).toContain('$ npm run typecheck → exit 0');
    expect(result.log).toContain('$ npm run test → exit 0');
  });

  it('excludes files already dirty before the fix (install artifacts)', async () => {
    const dir = await makeRepoDir({ scripts: { test: 'x' } });
    const status = statusSeq('?? package-lock.json\n', '?? package-lock.json\n M src/a.ts\n');
    installRunner((call) => status(call));

    const result = await applyKnipFixes(dir);

    expect(result.applied).toBe(true);
    expect(result.changedFiles).toEqual(['src/a.ts']);
  });

  it('treats an artifact-only dirty tree as "no changes"', async () => {
    const dir = await makeRepoDir({ scripts: { test: 'x' } });
    const status = statusSeq('?? package-lock.json\n', '?? package-lock.json\n');
    const calls = installRunner((call) => status(call));

    const result = await applyKnipFixes(dir);

    expect(result).toMatchObject({ applied: false, verified: true, changedFiles: [] });
    expect(calls.filter(isRun)).toEqual([]);
  });

  it('passes custom fix types through --fix-type', async () => {
    const dir = await makeRepoDir();
    const calls = installRunner();

    await applyKnipFixes(dir, { fixTypes: ['exports'] });

    expect(calls.find(isKnip)!.args).toEqual([
      '--yes',
      'knip@5',
      '--fix',
      '--fix-type',
      'exports',
      '--no-exit-code',
    ]);
  });

  it('runs the build script between typecheck and test when present', async () => {
    const dir = await makeRepoDir({
      scripts: { test: 'x', build: 'x', typecheck: 'x', lint: 'x' },
    });
    const status = statusSeq('', ' M a.ts\n');
    const calls = installRunner((call) => status(call));

    await applyKnipFixes(dir);

    expect(calls.filter(isRun).map((c) => c.args[1])).toEqual(['typecheck', 'build', 'test']);
  });

  it('uses the detected package manager for verify scripts', async () => {
    const dir = await makeRepoDir({ scripts: { test: 'x' }, lockfiles: ['yarn.lock'] });
    const status = statusSeq('', ' M a.ts\n');
    const calls = installRunner((call) => status(call));

    const result = await applyKnipFixes(dir);

    expect(calls.filter(isRun).map((c) => [c.cmd, ...c.args])).toEqual([['yarn', 'run', 'test']]);
    expect(result.log).toContain('$ yarn run test → exit 0');
  });

  it('uses opts.verifyCommands verbatim instead of package.json scripts', async () => {
    const dir = await makeRepoDir({ scripts: { test: 'x' } });
    const status = statusSeq('', ' M a.ts\n');
    const calls = installRunner((call) => status(call));

    const result = await applyKnipFixes(dir, { verifyCommands: ['node scripts/check.js --fast'] });

    expect(calls.filter(isRun)).toEqual([]);
    expect(calls.map((c) => [c.cmd, ...c.args])).toContainEqual([
      'node',
      'scripts/check.js',
      '--fast',
    ]);
    expect(result.verified).toBe(true);
    expect(result.log).toContain('$ node scripts/check.js --fast → exit 0');
  });

  it('reverts and reports verified false when a verify command fails', async () => {
    const dir = await makeRepoDir({ scripts: { typecheck: 'x', test: 'x' } });
    const status = statusSeq('', ' M src/a.ts\n');
    const calls = installRunner((call) => {
      if (isRun(call) && call.args[1] === 'test') return { code: 1, stderr: '1 test failed' };
      return status(call);
    });

    const result = await applyKnipFixes(dir);

    const argLists = calls.map((c) => [c.cmd, ...c.args]);
    expect(argLists).toContainEqual(['git', 'checkout', '--', '.']);
    expect(argLists).toContainEqual(['git', 'clean', '-fd']);
    // revert happens after the failing verify command
    const failIndex = argLists.findIndex((a) => a[1] === 'run' && a[2] === 'test');
    const revertIndex = argLists.findIndex((a) => a[1] === 'checkout');
    expect(failIndex).toBeGreaterThanOrEqual(0);
    expect(revertIndex).toBeGreaterThan(failIndex);

    expect(result.applied).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.changedFiles).toEqual(['src/a.ts']);
    expect(result.log).toContain('$ npm run test → exit 1');
    expect(result.log.some((line) => line.includes('1 test failed'))).toBe(true);
  });

  it('does not throw and does not verify when knip --fix made no changes', async () => {
    const dir = await makeRepoDir({ scripts: { test: 'x' } });
    const calls = installRunner((call) => {
      if (isStatus(call)) return { stdout: '' };
      return {};
    });

    const result = await applyKnipFixes(dir);

    expect(result).toMatchObject({ applied: false, verified: true, changedFiles: [] });
    expect(calls.filter(isRun)).toEqual([]);
  });

  it('captures a knip --fix crash in the log without throwing', async () => {
    const dir = await makeRepoDir({ scripts: { test: 'x' } });
    const calls = installRunner((call) => {
      if (isKnip(call)) return { code: 2, stderr: 'knip blew up' };
      if (isStatus(call)) return { stdout: '' };
      return {};
    });

    const result = await applyKnipFixes(dir);

    expect(result.applied).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.log.some((line) => line.includes('knip blew up'))).toBe(true);
    expect(calls.filter(isRun)).toEqual([]);
  });

  it('treats a repo without verify scripts as verified', async () => {
    const dir = await makeRepoDir({ scripts: { lint: 'x' } });
    const status = statusSeq('', ' M a.ts\n');
    installRunner((call) => status(call));

    const result = await applyKnipFixes(dir);

    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('handles rename entries in git status --porcelain', async () => {
    const dir = await makeRepoDir();
    const status = statusSeq('', 'R  src/old.ts -> src/new.ts\n M src/other.ts\n');
    installRunner((call) => status(call));

    const result = await applyKnipFixes(dir);

    expect(result.changedFiles).toEqual(['src/new.ts', 'src/other.ts']);
  });
});

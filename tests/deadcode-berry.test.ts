import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  setCommandRunnerForTests,
  type CommandOptions,
  type CommandResult,
} from '../src/dead-code/exec.js';
import { installDependencies } from '../src/dead-code/run.js';

interface Call {
  cmd: string;
  args: string[];
  opts: CommandOptions;
}

function installRunner() {
  const calls: Call[] = [];
  setCommandRunnerForTests(async (cmd, args, opts): Promise<CommandResult> => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: '', stderr: '' };
  });
  return calls;
}

const tempDirs: string[] = [];

async function makeRepoDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'janitor-berry-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  setCommandRunnerForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('installDependencies with Yarn Berry', () => {
  it('uses --immutable and disables scripts via env when .yarnrc.yml is present', async () => {
    const dir = await makeRepoDir({
      'package.json': JSON.stringify({ name: 'target' }),
      'yarn.lock': '',
      '.yarnrc.yml': 'nodeLinker: node-modules\n',
    });
    const calls = installRunner();

    await installDependencies(dir);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('yarn');
    expect(calls[0]!.args).toEqual(['install', '--immutable']);
    expect(calls[0]!.opts.env?.YARN_ENABLE_SCRIPTS).toBe('0');
    // the janitor token must never reach target-repo tooling
    expect(calls[0]!.opts.env?.JANITOR_TOKEN).toBeUndefined();
    expect(calls[0]!.opts.env?.GITHUB_TOKEN).toBeUndefined();
  });

  it('detects Berry from the packageManager field without .yarnrc.yml', async () => {
    const dir = await makeRepoDir({
      'package.json': JSON.stringify({ name: 'target', packageManager: 'yarn@4.5.0' }),
      'yarn.lock': '',
    });
    const calls = installRunner();

    await installDependencies(dir);

    expect(calls[0]!.args).toEqual(['install', '--immutable']);
  });

  it('keeps classic flags for yarn 1 repos', async () => {
    const dir = await makeRepoDir({
      'package.json': JSON.stringify({ name: 'target', packageManager: 'yarn@1.22.22' }),
      'yarn.lock': '',
    });
    const calls = installRunner();

    await installDependencies(dir);

    expect(calls[0]!.args).toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
  });
});

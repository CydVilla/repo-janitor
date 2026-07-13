import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  setCommandRunnerForTests,
  type CommandOptions,
  type CommandResult,
} from '../src/dead-code/exec.js';
import { detectPackageManager, installDependencies, runKnip } from '../src/dead-code/run.js';

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

const tempDirs: string[] = [];

async function makeRepoDir(files: string[] = []): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'janitor-run-'));
  tempDirs.push(dir);
  for (const file of files) {
    await writeFile(path.join(dir, file), '');
  }
  return dir;
}

afterEach(async () => {
  setCommandRunnerForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('detectPackageManager', () => {
  it('detects pnpm, yarn, and npm from lockfiles', async () => {
    expect(await detectPackageManager(await makeRepoDir(['pnpm-lock.yaml']))).toBe('pnpm');
    expect(await detectPackageManager(await makeRepoDir(['yarn.lock']))).toBe('yarn');
    expect(await detectPackageManager(await makeRepoDir(['package-lock.json']))).toBe('npm');
    expect(await detectPackageManager(await makeRepoDir([]))).toBe('npm');
  });

  it('prefers pnpm over yarn over npm when several lockfiles exist', async () => {
    const dir = await makeRepoDir(['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']);
    expect(await detectPackageManager(dir)).toBe('pnpm');
    const dir2 = await makeRepoDir(['yarn.lock', 'package-lock.json']);
    expect(await detectPackageManager(dir2)).toBe('yarn');
  });
});

describe('installDependencies', () => {
  const matrix: Array<{ lockfiles: string[]; cmd: string; args: string[] }> = [
    {
      lockfiles: ['pnpm-lock.yaml'],
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile', '--ignore-scripts'],
    },
    {
      lockfiles: ['yarn.lock'],
      cmd: 'yarn',
      args: ['install', '--frozen-lockfile', '--ignore-scripts'],
    },
    { lockfiles: ['package-lock.json'], cmd: 'npm', args: ['ci', '--ignore-scripts'] },
    { lockfiles: [], cmd: 'npm', args: ['install', '--ignore-scripts'] },
  ];

  it.each(matrix)('uses $cmd $args for lockfiles $lockfiles', async ({ lockfiles, cmd, args }) => {
    const dir = await makeRepoDir(lockfiles);
    const calls = installRunner();

    await installDependencies(dir);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(cmd);
    expect(calls[0]!.args).toEqual(args);
    expect(calls[0]!.opts.cwd).toBe(dir);
  });

  it('always passes --ignore-scripts', async () => {
    for (const { lockfiles } of matrix) {
      const dir = await makeRepoDir(lockfiles);
      const calls = installRunner();
      await installDependencies(dir);
      expect(calls[0]!.args).toContain('--ignore-scripts');
    }
  });

  it('throws with a stderr excerpt when the install fails', async () => {
    const dir = await makeRepoDir(['package-lock.json']);
    installRunner(() => ({ code: 1, stderr: 'ERESOLVE unable to resolve dependency tree' }));

    await expect(installDependencies(dir)).rejects.toThrow(/npm ci .*exit 1.*ERESOLVE/s);
  });
});

describe('runKnip', () => {
  it('invokes npx --yes knip@5 --reporter json --no-exit-code in the repo dir', async () => {
    const dir = await makeRepoDir();
    const calls = installRunner(() => ({ stdout: '{"files":[],"issues":[]}' }));

    const result = await runKnip(dir);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('npx');
    expect(calls[0]!.args).toEqual(['--yes', 'knip@5', '--reporter', 'json', '--no-exit-code']);
    expect(calls[0]!.opts.cwd).toBe(dir);
    expect(result).toEqual({ findings: [] });
  });

  it('maps every knip v5 issue type to the right category', async () => {
    const report = {
      files: ['src/dead.ts'],
      issues: [
        {
          file: 'src/a.ts',
          exports: [{ name: 'unusedFn', line: 10, col: 14 }],
          types: [{ name: 'UnusedType', line: 20, col: 1 }],
          nsTypes: [{ name: 'NsType', line: 21, col: 1 }],
          enumMembers: { Color: [{ name: 'Blue', line: 5, col: 3 }] },
          classMembers: { Widget: [{ name: 'spin', line: 8, col: 3 }] },
          dependencies: [{ name: 'lodash' }],
          devDependencies: [{ name: 'rimraf' }],
          unlisted: [{ name: 'left-pad' }],
          unresolved: [{ name: './missing.js' }],
          duplicates: [
            [
              { name: 'dup', line: 1, col: 1 },
              { name: 'dup!', line: 2, col: 1 },
            ],
          ],
          futureIssueType: [{ name: 'mystery' }],
        },
      ],
    };
    const dir = await makeRepoDir();
    installRunner(() => ({ stdout: JSON.stringify(report) }));

    const { findings, knipError } = await runKnip(dir);

    expect(knipError).toBeUndefined();
    expect(findings).toContainEqual({ category: 'unused-file', file: 'src/dead.ts' });
    expect(findings).toContainEqual({
      category: 'unused-export',
      file: 'src/a.ts',
      name: 'unusedFn',
      line: 10,
      col: 14,
    });
    expect(findings).toContainEqual({
      category: 'unused-type',
      file: 'src/a.ts',
      name: 'UnusedType',
      line: 20,
      col: 1,
    });
    expect(findings).toContainEqual({
      category: 'unused-type',
      file: 'src/a.ts',
      name: 'NsType',
      line: 21,
      col: 1,
    });
    expect(findings).toContainEqual({
      category: 'unused-enum-member',
      file: 'src/a.ts',
      name: 'Color.Blue',
      line: 5,
      col: 3,
    });
    expect(findings).toContainEqual({
      category: 'unused-class-member',
      file: 'src/a.ts',
      name: 'Widget.spin',
      line: 8,
      col: 3,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ category: 'unused-dependency', name: 'lodash' }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ category: 'unused-dependency', name: 'rimraf' }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ category: 'unlisted-dependency', name: 'left-pad' }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ category: 'unresolved-import', name: './missing.js' }),
    );
    expect(findings).toContainEqual({
      category: 'duplicate-export',
      file: 'src/a.ts',
      name: 'dup',
      line: 1,
      col: 1,
    });
    expect(findings).toContainEqual({
      category: 'duplicate-export',
      file: 'src/a.ts',
      name: 'dup!',
      line: 2,
      col: 1,
    });
    expect(findings).toContainEqual(expect.objectContaining({ category: 'other', name: 'mystery' }));
    expect(findings).toHaveLength(13);
  });

  it('accepts plain-string dependency entries', async () => {
    const report = { files: [], issues: [{ file: 'package.json', dependencies: ['lodash'] }] };
    const dir = await makeRepoDir();
    installRunner(() => ({ stdout: JSON.stringify(report) }));

    const { findings } = await runKnip(dir);

    expect(findings).toEqual([
      { category: 'unused-dependency', file: 'package.json', name: 'lodash' },
    ]);
  });

  it('tolerates npx noise around the JSON document', async () => {
    const dir = await makeRepoDir();
    installRunner(() => ({
      stdout: 'npm warn something\n{"files":["gone.ts"],"issues":[]}\n',
    }));

    const { findings, knipError } = await runKnip(dir);

    expect(knipError).toBeUndefined();
    expect(findings).toEqual([{ category: 'unused-file', file: 'gone.ts' }]);
  });

  it('reports knipError with a stderr excerpt on nonzero exit', async () => {
    const dir = await makeRepoDir();
    installRunner(() => ({
      code: 2,
      stdout: '{"files":["ignored.ts"],"issues":[]}',
      stderr: 'knip exploded: config not found',
    }));

    const result = await runKnip(dir);

    expect(result.findings).toEqual([]);
    expect(result.knipError).toMatch(/code 2/);
    expect(result.knipError).toContain('knip exploded: config not found');
  });

  it('reports knipError when stdout is not JSON', async () => {
    const dir = await makeRepoDir();
    installRunner(() => ({ stdout: 'this is not json at all' }));

    const result = await runKnip(dir);

    expect(result.findings).toEqual([]);
    expect(result.knipError).toMatch(/parse/i);
  });
});

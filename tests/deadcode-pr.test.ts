import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import {
  setCommandRunnerForTests,
  type CommandOptions,
  type CommandResult,
} from '../src/dead-code/exec.js';
import type { DeadCodeFinding } from '../src/types.js';
import type { FixResult } from '../src/dead-code/fix.js';
import { createDeadCodePR } from '../src/dead-code/pr.js';

const TOKEN = 'ghp_janitor_secret_42';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const REPO_DIR = '/work/octo__repo';
const PR_URL = 'https://github.com/octo/repo/pull/5';

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

function fakeOctokit(
  opts: { openHeads?: string[]; defaultBranch?: string } = {},
): { octokit: Octokit; list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => ({
    data: (opts.openHeads ?? []).map((ref) => ({ head: { ref } })),
  }));
  const create = vi.fn(async () => ({ data: { html_url: PR_URL } }));
  const get = vi.fn(async () => ({ data: { default_branch: opts.defaultBranch ?? 'main' } }));
  // Mirrors real octokit.paginate closely enough: calls the endpoint fn and
  // unwraps .data (single page in these tests).
  const paginate = vi.fn(
    async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
      (await fn(params)).data,
  );
  const octokit = { pulls: { list, create }, repos: { get }, paginate } as unknown as Octokit;
  return { octokit, list, create, get };
}

const FINDINGS: DeadCodeFinding[] = [
  { category: 'unused-export', file: 'src/a.ts', name: 'unusedFn', line: 10 },
  { category: 'unused-export', file: 'src/b.ts', name: 'gone', line: 3 },
  { category: 'unused-type', file: 'src/a.ts', name: 'OldType', line: 22 },
  { category: 'unused-enum-member', file: 'src/e.ts', name: 'Color.Blue', line: 5 },
  { category: 'unused-dependency', file: 'package.json', name: 'lodash' },
];

const FIX: FixResult = {
  applied: true,
  verified: true,
  changedFiles: ['src/a.ts', 'src/b.ts'],
  log: ['$ npx --yes knip@5 --fix --fix-type exports,types → exit 0', '$ npm run test → exit 0'],
};

beforeEach(() => {
  vi.stubEnv('JANITOR_TOKEN', TOKEN);
  vi.stubEnv('GITHUB_TOKEN', undefined);
  vi.useFakeTimers({ now: new Date('2026-07-12T10:00:00Z'), toFake: ['Date'] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  setCommandRunnerForTests(null);
});

describe('createDeadCodePR', () => {
  it('returns null and touches nothing when a repo-janitor PR is already open', async () => {
    const { octokit, list, create } = fakeOctokit({
      openHeads: ['feature/x', 'repo-janitor/dead-code-2026-01-01'],
    });
    const calls = installRunner();

    const result = await createDeadCodePR(octokit, 'octo/repo', REPO_DIR, FINDINGS, FIX);

    expect(result).toBeNull();
    expect(list).toHaveBeenCalledWith({ owner: 'octo', repo: 'repo', state: 'open', per_page: 100 });
    expect(create).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('branches, stages only the fixed files, commits, force-pushes with the extraheader trick, and opens the PR', async () => {
    const { octokit, create } = fakeOctokit();
    const calls = installRunner();

    const result = await createDeadCodePR(octokit, 'octo/repo', REPO_DIR, FINDINGS, FIX, {
      baseBranch: 'dev',
    });

    const branch = 'repo-janitor/dead-code-2026-07-12';
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['git', 'checkout', '-b', branch],
      // only fix.changedFiles — never -A, which would sweep in install/verify artifacts
      ['git', 'add', '--', 'src/a.ts', 'src/b.ts'],
      [
        'git',
        '-c',
        'user.name=repo-janitor',
        '-c',
        'user.email=repo-janitor@users.noreply.github.com',
        'commit',
        '-m',
        'chore: remove dead code (repo-janitor)',
      ],
      [
        'git',
        '-c',
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${BASIC}`,
        'push',
        '--force',
        'origin',
        branch,
      ],
    ]);
    for (const call of calls) {
      expect(call.opts.cwd).toBe(REPO_DIR);
      // the raw token never appears in any argument (only the basic credential header)
      for (const arg of call.args) expect(arg).not.toContain(TOKEN);
      expect(call.args.join(' ')).not.toContain(`https://x-access-token`);
    }

    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0]![0] as {
      owner: string;
      repo: string;
      head: string;
      base: string;
      title: string;
      body: string;
    };
    expect(createArgs.owner).toBe('octo');
    expect(createArgs.repo).toBe('repo');
    expect(createArgs.head).toBe(branch);
    expect(createArgs.base).toBe('dev');
    expect(result).toEqual({ url: PR_URL });
  });

  it('falls back to the repo default branch when baseBranch is not given', async () => {
    const { octokit, get, create } = fakeOctokit({ defaultBranch: 'trunk' });
    installRunner();

    await createDeadCodePR(octokit, 'octo/repo', REPO_DIR, FINDINGS, FIX);

    expect(get).toHaveBeenCalledWith({ owner: 'octo', repo: 'repo' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ base: 'trunk' }));
  });

  it('renders a body with grouped findings, a capped list, the fix log, and a verification note', async () => {
    const { octokit, create } = fakeOctokit();
    installRunner();

    await createDeadCodePR(octokit, 'octo/repo', REPO_DIR, FINDINGS, FIX, {
      baseBranch: 'main',
      maxFindingsInBody: 2,
    });

    const body = (create.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain('## Findings (5)');
    expect(body).toContain('### Unused exports (2)');
    expect(body).toContain('`unusedFn` — src/a.ts:10');
    expect(body).toContain('+3 more');
    expect(body).toContain('<details>');
    expect(body).toContain('$ npm run test → exit 0');
    expect(body).toMatch(/verification passed/i);
    // capped at 2: findings beyond the cap are not listed
    expect(body).not.toContain('Color.Blue');
  });

  it('lists all findings when under the default cap', async () => {
    const { octokit, create } = fakeOctokit();
    installRunner();

    await createDeadCodePR(octokit, 'octo/repo', REPO_DIR, FINDINGS, FIX, { baseBranch: 'main' });

    const body = (create.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain('Color.Blue');
    expect(body).toContain('`lodash` — package.json');
    expect(body).not.toContain('more not listed');
  });

  it('scrubs the token from git failures', async () => {
    const { octokit, create } = fakeOctokit();
    installRunner((call) => {
      if (call.args.includes('push')) {
        return { code: 128, stderr: `fatal: auth failed for basic ${BASIC} (${TOKEN})` };
      }
      return {};
    });

    const error = await createDeadCodePR(octokit, 'octo/repo', REPO_DIR, FINDINGS, FIX, {
      baseBranch: 'main',
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('***');
    expect(error!.message).not.toContain(TOKEN);
    expect(error!.message).not.toContain(BASIC);
    expect(create).not.toHaveBeenCalled();
  });

  it('scrubs the token from octokit failures too', async () => {
    const { octokit, create } = fakeOctokit();
    create.mockRejectedValueOnce(new Error(`422 Validation Failed (token ${TOKEN})`));
    installRunner();

    await expect(
      createDeadCodePR(octokit, 'octo/repo', REPO_DIR, FINDINGS, FIX, { baseBranch: 'main' }),
    ).rejects.toThrow(/\*\*\*/);
  });

  it('rejects invalid repo names before doing anything', async () => {
    const { octokit, list } = fakeOctokit();
    const calls = installRunner();

    await expect(
      createDeadCodePR(octokit, 'not-a-repo', REPO_DIR, FINDINGS, FIX),
    ).rejects.toThrow(/expected "owner\/name"/);
    expect(list).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

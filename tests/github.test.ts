import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Octokit } from '@octokit/rest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { cloneRepo, getOctokit, getToken, parseRepo, scrubToken } from '../src/github.js';

type ExecFileCallback = (error: Error | null) => void;

describe('parseRepo', () => {
  const accepted: Array<[string, { owner: string; name: string }]> = [
    ['octo/repo', { owner: 'octo', name: 'repo' }],
    ['octo-org/my_repo', { owner: 'octo-org', name: 'my_repo' }],
    ['a.b/c-d_e.f', { owner: 'a.b', name: 'c-d_e.f' }],
    ['A1/B2.git', { owner: 'A1', name: 'B2.git' }],
  ];

  it.each(accepted)('accepts %s', (input, expected) => {
    expect(parseRepo(input)).toEqual(expected);
  });

  const rejected = [
    '',
    'octo',
    'octo/',
    '/repo',
    'octo/repo/extra',
    'octo repo/x',
    'octo/re po',
    ' octo/repo',
    'octo/repo ',
    'octo/repo\n',
    'octo\trepo',
    'octo\\repo',
    '../repo',
    'octo/..',
    './repo',
    'octo/.',
    '../..',
    'https://github.com/octo/repo',
  ];

  it.each(rejected)('rejects %j', (input) => {
    expect(() => parseRepo(input)).toThrow(/expected "owner\/name"/);
  });
});

describe('getToken', () => {
  it('prefers JANITOR_TOKEN over GITHUB_TOKEN', () => {
    expect(getToken({ JANITOR_TOKEN: 'jan', GITHUB_TOKEN: 'gh' })).toBe('jan');
  });

  it('falls back to GITHUB_TOKEN', () => {
    expect(getToken({ GITHUB_TOKEN: 'gh' })).toBe('gh');
  });

  it('throws naming both variables when neither is set', () => {
    expect(() => getToken({})).toThrow(/JANITOR_TOKEN/);
    expect(() => getToken({})).toThrow(/GITHUB_TOKEN/);
  });

  it('treats empty strings as unset', () => {
    expect(() => getToken({ JANITOR_TOKEN: '', GITHUB_TOKEN: '' })).toThrow(/JANITOR_TOKEN/);
  });

  it('falls back to GITHUB_TOKEN when JANITOR_TOKEN is the empty string', () => {
    // GitHub Actions expands an unset secret to '' while still defining the var.
    expect(getToken({ JANITOR_TOKEN: '', GITHUB_TOKEN: 'gh' })).toBe('gh');
  });
});

describe('getOctokit', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns an Octokit instance when a token is set', () => {
    vi.stubEnv('JANITOR_TOKEN', 'tok');
    expect(getOctokit()).toBeInstanceOf(Octokit);
  });

  it('throws when no token is available', () => {
    vi.stubEnv('JANITOR_TOKEN', undefined);
    vi.stubEnv('GITHUB_TOKEN', undefined);
    expect(() => getOctokit()).toThrow(/JANITOR_TOKEN/);
  });
});

describe('scrubToken', () => {
  const token = 'ghp_supersecret123';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');

  it('removes the raw token', () => {
    const out = scrubToken(`auth failed for ${token}!`, token);
    expect(out).toBe('auth failed for ***!');
  });

  it('removes the base64 basic credential', () => {
    const out = scrubToken(`header AUTHORIZATION: basic ${basic} rejected`, token);
    expect(out).not.toContain(basic);
    expect(out).toContain('***');
  });

  it('removes every occurrence of both forms', () => {
    const out = scrubToken(`${token} ${basic} ${token}`, token);
    expect(out).not.toContain(token);
    expect(out).not.toContain(basic);
    expect(out).toBe('*** *** ***');
  });

  it('leaves unrelated messages untouched', () => {
    expect(scrubToken('nothing sensitive here', token)).toBe('nothing sensitive here');
  });
});

describe('cloneRepo', () => {
  const token = 'tok-abc';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');

  beforeEach(() => {
    execFileMock.mockReset();
    vi.stubEnv('JANITOR_TOKEN', token);
    vi.stubEnv('GITHUB_TOKEN', undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('runs git with auth header, depth 1 and --single-branch by default', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: ExecFileCallback) => cb(null));

    await cloneRepo('octo/repo', '/tmp/dest');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[], ExecFileCallback];
    expect(cmd).toBe('git');
    expect(args).toEqual([
      '-c',
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
      'clone',
      '--depth',
      '1',
      '--single-branch',
      'https://github.com/octo/repo.git',
      '/tmp/dest',
    ]);
  });

  it('passes --branch and a custom --depth when provided', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: ExecFileCallback) => cb(null));

    await cloneRepo('octo/repo', '/tmp/dest', { branch: 'dev', depth: 5 });

    const [, args] = execFileMock.mock.calls[0] as [string, string[], ExecFileCallback];
    expect(args).toContain('--single-branch');
    expect(args.join(' ')).toContain('--depth 5');
    expect(args.join(' ')).toContain('--branch dev');
  });

  it('never embeds the token in the clone URL', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: ExecFileCallback) => cb(null));

    await cloneRepo('octo/repo', '/tmp/dest');

    const [, args] = execFileMock.mock.calls[0] as [string, string[], ExecFileCallback];
    const url = args.find((a) => a.startsWith('https://'));
    expect(url).toBe('https://github.com/octo/repo.git');
  });

  it('scrubs the raw and base64 token from rethrown errors', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: ExecFileCallback) =>
      cb(new Error(`exit 128: 'AUTHORIZATION: basic ${basic}' with ${token} rejected`)),
    );

    const err = await cloneRepo('octo/repo', '/tmp/dest').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('octo/repo');
    expect(err!.message).toContain('***');
    expect(err!.message).not.toContain(token);
    expect(err!.message).not.toContain(basic);
  });

  it('rejects invalid repo names before spawning git', async () => {
    await expect(cloneRepo('octo/../repo', '/tmp/dest')).rejects.toThrow(/expected "owner\/name"/);
    await expect(cloneRepo('octo/..', '/tmp/dest')).rejects.toThrow(/expected "owner\/name"/);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

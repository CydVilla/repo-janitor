import { execFile } from 'node:child_process';
import { Octokit } from '@octokit/rest';

const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** Validates and splits "owner/name". Throws on anything else. */
export function parseRepo(full: string): { owner: string; name: string } {
  const match = REPO_RE.exec(full);
  const owner = match?.[1];
  const name = match?.[2];
  if (!owner || !name || isDotSegment(owner) || isDotSegment(name)) {
    throw new Error(`Invalid repo "${full}": expected "owner/name" (letters, digits, ., _, -)`);
  }
  return { owner, name };
}

function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..';
}

/**
 * Resolve the token: JANITOR_TOKEN (fine-grained PAT for cross-repo access)
 * falling back to GITHUB_TOKEN. Throws with a helpful message when neither
 * is set.
 */
export function getToken(env: NodeJS.ProcessEnv = process.env): string {
  // `||`, not `??`: GitHub Actions expands an unset secret to '' while still
  // defining the env var, and that must fall through to GITHUB_TOKEN.
  const token = env.JANITOR_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'No GitHub token available. Set JANITOR_TOKEN (a fine-grained PAT with access ' +
        'to the onboarded repos) or GITHUB_TOKEN (e.g. the token provided by GitHub Actions).',
    );
  }
  return token;
}

export function getOctokit(): Octokit {
  return new Octokit({ auth: getToken() });
}

/** Replace every occurrence of the token — raw or base64-encoded — with '***'. */
export function scrubToken(message: string, token: string): string {
  if (!token) return message;
  return message
    .replaceAll(basicCredential(token), '***')
    .replaceAll(Buffer.from(token).toString('base64'), '***')
    .replaceAll(token, '***');
}

function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/**
 * Shallow-clone a repo into destDir.
 *
 * Behavior contract:
 * - Uses execFile (argument arrays, never a shell) — repo names are validated
 *   via parseRepo before use.
 * - Authenticates via an http.extraheader git config flag, NOT by embedding
 *   the token in the clone URL (keeps it out of .git/config and error output).
 * - Scrubs the token from any error message before rethrowing.
 * - depth defaults to 1; branch checked out when provided.
 */
export async function cloneRepo(
  repoFullName: string,
  destDir: string,
  opts: { branch?: string; depth?: number } = {},
): Promise<void> {
  const { owner, name } = parseRepo(repoFullName);
  const token = getToken();

  const args = [
    '-c',
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicCredential(token)}`,
    'clone',
    '--depth',
    String(opts.depth ?? 1),
    '--single-branch',
  ];
  if (opts.branch) args.push('--branch', opts.branch);
  args.push(`https://github.com/${owner}/${name}.git`, destDir);

  await new Promise<void>((resolve, reject) => {
    execFile('git', args, (error) => {
      if (error) {
        const detail = scrubToken(error.message || String(error), token);
        reject(new Error(`git clone of ${owner}/${name} failed: ${detail}`));
      } else {
        resolve();
      }
    });
  });
}

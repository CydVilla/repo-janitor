import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractLinks } from '../src/link-checker/extract.js';

const dirs: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'janitor-extract-edges-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('extractLinks markdown edge cases', () => {
  it('splits badge rows into both URLs instead of one mangled key', async () => {
    const dir = await fixture({
      'README.md': '[![CI](https://img.shields.io/badge/ci-pass-green)](https://ci.test/runs)\n',
    });

    const links = await extractLinks(dir);

    expect([...links.keys()].sort()).toEqual([
      'https://ci.test/runs',
      'https://img.shields.io/badge/ci-pass-green',
    ]);
  });

  it('extracts the URL (not a mangled composite) from a self-link', async () => {
    const dir = await fixture({
      'README.md': '[https://site.test/docs](https://site.test/docs)\n',
    });

    const links = await extractLinks(dir);

    expect([...links.keys()]).toEqual(['https://site.test/docs']);
  });

  it('stops at pipes so spaceless table cells stay clean', async () => {
    const dir = await fixture({ 'README.md': '|https://tight.test/cell|desc|\n' });

    expect([...(await extractLinks(dir)).keys()]).toEqual(['https://tight.test/cell']);
  });

  it('trims trailing bold markers from bare URLs', async () => {
    const dir = await fixture({ 'README.md': '**https://bold.test/docs**\n' });

    expect([...(await extractLinks(dir)).keys()]).toEqual(['https://bold.test/docs']);
  });

  it('still keeps balanced wiki-style parens intact', async () => {
    const dir = await fixture({
      'notes.md': 'see https://en.wikipedia.org/wiki/Dead_code_(disambiguation) for more\n',
    });

    expect([...(await extractLinks(dir)).keys()]).toEqual([
      'https://en.wikipedia.org/wiki/Dead_code_(disambiguation)',
    ]);
  });
});

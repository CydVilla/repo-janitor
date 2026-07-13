import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractLinks } from '../src/link-checker/extract.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function write(root: string, relPath: string, content: string): Promise<void> {
  const full = path.join(root, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

/** A repo-shaped fixture tree exercising every extract behavior at once. */
async function makeFixtureTree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repo-janitor-extract-'));
  tmpDirs.push(root);

  await write(
    root,
    'README.md',
    [
      '# Hello',
      '',
      'A [guide](https://docs.test/guide) link and a bare https://bare.test/path.',
      'Wiki [link](https://en.wikipedia.org/wiki/Foo_(bar)) stays intact.',
      'Trailing period https://period.test/x.',
    ].join('\n'),
  );

  // Same URL as README line 3, in another file: dedupe + occurrences.
  await write(root, 'docs/guide.md', 'See https://docs.test/guide for details.\n');

  // URL inside a TS comment.
  await write(
    root,
    'src/app.ts',
    '// docs: https://api.test/reference\nexport const nothing = 1;\n',
  );

  // URLs that must be filtered out by the built-in ignore patterns.
  await write(
    root,
    'src/settings.ts',
    [
      "const local = 'http://localhost:3000/health';",
      "const loopback = 'http://127.0.0.1:8080/';",
      "const ex = 'https://example.com/whatever';",
      "const exSub = 'https://api.example.org/v1';",
      "const mustache = 'https://api.test/items/{{id}}';",
      "const interp = 'https://api.test/users/${userId}';",
      "const printf = 'https://api.test/%s/download';",
      "const schema = 'https://schemas.test/ns/thing';",
      "const w3 = 'https://www.w3.org/1999/xhtml';",
    ].join('\n'),
  );

  // Files that must be skipped entirely.
  await write(root, 'node_modules/pkg/index.js', "module.exports = 'https://skip.test/nm';\n");
  await write(root, 'package-lock.json', '{"resolved": "https://skip.test/lockfile"}\n');
  await write(root, 'yarn.lock', 'resolved "https://skip.test/yarn"\n');
  await write(root, 'dist/bundle.js', "fetch('https://skip.test/dist');\n");
  await write(root, 'logo.png', 'https://skip.test/binary-extension\n');
  await write(root, 'blob.txt', '\u0000https://skip.test/binary-sniff\n');

  return root;
}

describe('extractLinks', () => {
  it('collects exactly the checkable URLs from the tree', async () => {
    const root = await makeFixtureTree();

    const links = await extractLinks(root);

    expect([...links.keys()].sort()).toEqual([
      'https://api.test/reference',
      'https://bare.test/path',
      'https://docs.test/guide',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://period.test/x',
    ]);
  });

  it('records every occurrence with correct file and 1-based line', async () => {
    const root = await makeFixtureTree();

    const links = await extractLinks(root);

    expect(links.get('https://docs.test/guide')).toEqual([
      { file: 'README.md', line: 3 },
      { file: 'docs/guide.md', line: 1 },
    ]);
    expect(links.get('https://bare.test/path')).toEqual([{ file: 'README.md', line: 3 }]);
    expect(links.get('https://period.test/x')).toEqual([{ file: 'README.md', line: 5 }]);
    expect(links.get('https://api.test/reference')).toEqual([
      { file: path.join('src', 'app.ts'), line: 1 },
    ]);
  });

  it('trims the markdown closing paren but keeps balanced wiki-style parens', async () => {
    const root = await makeFixtureTree();

    const links = await extractLinks(root);

    // [guide](https://docs.test/guide) -> unbalanced ')' stripped.
    expect(links.has('https://docs.test/guide')).toBe(true);
    expect(links.has('https://docs.test/guide)')).toBe(false);
    // .../Foo_(bar) is balanced after stripping the markdown closer.
    expect(links.get('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      { file: 'README.md', line: 4 },
    ]);
    expect(links.has('https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(false);
  });

  it('skips node_modules, dist, lockfiles, binary extensions, and NUL-sniffed files', async () => {
    const root = await makeFixtureTree();

    const links = await extractLinks(root);

    const skipped = [...links.keys()].filter((url) => url.includes('skip.test'));
    expect(skipped).toEqual([]);
  });

  it('filters localhost, example domains, templated, printf, and schema URLs', async () => {
    const root = await makeFixtureTree();

    const links = await extractLinks(root);

    const fromSettings = [...links.values()]
      .flat()
      .filter((occ) => occ.file === path.join('src', 'settings.ts'));
    expect(fromSettings).toEqual([]);
  });

  it('applies custom ignoreUrlPatterns on top of the built-ins', async () => {
    const root = await makeFixtureTree();

    const links = await extractLinks(root, { ignoreUrlPatterns: ['^https://bare\\.test/'] });

    expect(links.has('https://bare.test/path')).toBe(false);
    expect(links.has('https://docs.test/guide')).toBe(true);
  });

  it('rejects invalid ignoreUrlPatterns entries with a helpful error', async () => {
    const root = await makeFixtureTree();

    await expect(extractLinks(root, { ignoreUrlPatterns: ['('] })).rejects.toThrow(
      /invalid ignoreUrlPatterns entry/,
    );
  });
});

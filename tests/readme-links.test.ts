/**
 * Every relative link in the README has to resolve to something that exists.
 *
 * It is the one document people read before the code, and `docs/` is
 * gitignored — so a link that points into it is a dead link for everyone but
 * the person who wrote it. Absolute links are someone else's problem and are
 * skipped; in-page anchors are checked against the headings.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `[text](target)`, ignoring image embeds, which are `![text](target)`. */
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

async function readmeLinks(): Promise<string[]> {
  const text = await readFile(join(root, 'README.md'), 'utf8');
  return [...text.matchAll(LINK)].map((m) => m[1]);
}

/** GitHub's slug: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

async function readmeAnchors(): Promise<Set<string>> {
  const text = await readFile(join(root, 'README.md'), 'utf8');
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
  return new Set(headings);
}

describe('README links', () => {
  it('finds links to check', async () => {
    // A regex that silently matched nothing would make every test below pass.
    expect((await readmeLinks()).length).toBeGreaterThan(5);
  });

  it('resolves every relative file link', async () => {
    const links = await readmeLinks();
    const relative = links.filter(
      (href) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#'),
    );

    const missing = relative.filter((href) => {
      const [path] = href.split('#');
      return path !== '' && !existsSync(join(root, path));
    });

    expect(missing).toEqual([]);
  });

  it('resolves every in-page anchor', async () => {
    const anchors = await readmeAnchors();
    const links = await readmeLinks();
    const inPage = links.filter((href) => href.startsWith('#')).map((href) => href.slice(1));

    expect(inPage.filter((a) => !anchors.has(a))).toEqual([]);
  });

  it('points at the wiki rather than at gitignored docs', async () => {
    const links = await readmeLinks();

    // docs/ holds internal working documents and is not published, so a link
    // into it reads as broken to everyone who clones the repo.
    expect(links.filter((href) => href.startsWith('docs/'))).toEqual([]);
  });
});

import { defineCollection } from 'astro:content';
import { readdir } from 'node:fs/promises';
import type { Loader } from 'astro/loaders';
import { z } from 'astro/zod';
import { DESCRIPTIONS, UNPUBLISHED } from './data/docs.ts';
import { mergeReleases } from './lib/changelog.ts';
import { splitTitle, summarise } from './lib/guides.ts';
import { GUIDES_DIR, rewriteGuideLinks } from './lib/links.ts';
import { readRepoFile, readTagDates, releaseVersion, repoRoot } from './lib/repo.ts';

async function publishedGuides(siteRoot: URL): Promise<string[]> {
  const files = await readdir(new URL(`${GUIDES_DIR}/`, repoRoot(siteRoot)));
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .filter((name) => !UNPUBLISHED.has(name));
}

/** The guides in docs/guides/, read from the repository rather than copied. */
const guidesLoader: Loader = {
  name: 'helpdock-guides',
  async load({ config, store, renderMarkdown, watcher }) {
    const names = await publishedGuides(config.root);
    const context = { sourceDir: GUIDES_DIR, publishedGuides: new Set(names) };
    store.clear();
    for (const name of names) {
      const path = `${GUIDES_DIR}/${name}.md`;
      const { title, body } = splitTitle(readRepoFile(config.root, path), name);
      const rendered = await renderMarkdown(body);
      store.set({
        id: name,
        data: { title, description: DESCRIPTIONS[name] ?? summarise(body), path },
        rendered: { ...rendered, html: rewriteGuideLinks(rendered.html, context) },
      });
    }
    watcher?.add(new URL(`${GUIDES_DIR}/`, repoRoot(config.root)).pathname);
  },
};

/** Every release up to the one the site shows, from both changelogs and the tags. */
const releasesLoader: Loader = {
  name: 'helpdock-releases',
  async load({ config, store, renderMarkdown }) {
    const context = {
      sourceDir: '.',
      publishedGuides: new Set(await publishedGuides(config.root)),
    };
    const releases = mergeReleases({
      notes: readRepoFile(config.root, 'CHANGELOG.md'),
      changes: readRepoFile(config.root, 'apps/api/CHANGELOG.md'),
      tagDates: readTagDates(config.root),
      current: releaseVersion(config.root),
    });
    store.clear();
    for (const release of releases) {
      const rendered = await renderMarkdown(release.body);
      store.set({
        id: release.version,
        data: { version: release.version, date: release.date, source: release.source },
        rendered: { ...rendered, html: rewriteGuideLinks(rendered.html, context) },
      });
    }
  },
};

export const collections = {
  guides: defineCollection({
    loader: guidesLoader,
    schema: z.object({ title: z.string(), description: z.string(), path: z.string() }),
  }),
  releases: defineCollection({
    loader: releasesLoader,
    schema: z.object({
      version: z.string(),
      date: z.string().optional(),
      source: z.enum(['notes', 'changes', 'tag']),
    }),
  }),
};

import { defineCollection } from 'astro:content';
import { readdir } from 'node:fs/promises';
import type { Loader } from 'astro/loaders';
import { z } from 'astro/zod';
import { DESCRIPTIONS, UNPUBLISHED } from './data/docs.ts';
import { SITE_URL } from './data/site.ts';
import { mergeReleases } from './lib/changelog.ts';
import { splitTitle, summarise } from './lib/guides.ts';
import {
  GUIDES_DIR,
  type LinkContext,
  rewriteGuideLinks,
  rewriteMarkdownLinks,
} from './lib/links.ts';
import { isFolded, parseNotes } from './lib/release-notes.ts';
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
      const source = readRepoFile(config.root, path);
      const { title, body } = splitTitle(source, name);
      const rendered = await renderMarkdown(body);
      store.set({
        id: name,
        data: {
          title,
          description: DESCRIPTIONS[name] ?? summarise(body),
          path,
          // The guide as Markdown with every link absolute, for /docs/<guide>.md,
          // the downloads, llms-full.txt and the agent skill.
          markdown: rewriteMarkdownLinks(source, context, `${SITE_URL}/docs/${name}/`),
        },
        rendered: { ...rendered, html: rewriteGuideLinks(rendered.html, context) },
      });
    }
    watcher?.add(new URL(`${GUIDES_DIR}/`, repoRoot(config.root)).pathname);
  },
};

type Render = (markdown: string) => Promise<{ html: string }>;

async function renderHtml(render: Render, markdown: string, context: LinkContext) {
  return rewriteGuideLinks((await render(markdown)).html, context);
}

/** A title is one line of Markdown; the paragraph Astro wraps it in is dropped. */
async function renderInline(render: Render, markdown: string, context: LinkContext) {
  return (await renderHtml(render, markdown, context)).replace(/^<p>([\s\S]*)<\/p>\s*$/, '$1');
}

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
      const notes = parseNotes(release.body);
      const groups = [];
      for (const group of notes.groups) {
        const items = [];
        for (const item of group.items) {
          items.push({
            lead: item.lead ? await renderInline(renderMarkdown, item.lead, context) : undefined,
            body: item.body ? await renderHtml(renderMarkdown, item.body, context) : '',
            pullRequests: item.pullRequests,
          });
        }
        groups.push({
          heading: group.heading,
          kind: group.kind,
          folded: isFolded(group.kind),
          items,
          paragraphs: await renderHtml(renderMarkdown, group.paragraphs.join('\n\n'), context),
        });
      }
      store.set({
        id: release.version,
        data: {
          version: release.version,
          date: release.date,
          source: release.source,
          intro: await renderHtml(renderMarkdown, notes.intro.join('\n\n'), context),
          groups,
        },
      });
    }
  },
};

const PullRequest = z.object({ number: z.string(), url: z.string() });

export const collections = {
  guides: defineCollection({
    loader: guidesLoader,
    schema: z.object({
      title: z.string(),
      description: z.string(),
      path: z.string(),
      markdown: z.string(),
    }),
  }),
  releases: defineCollection({
    loader: releasesLoader,
    schema: z.object({
      version: z.string(),
      date: z.string().optional(),
      source: z.enum(['notes', 'changes', 'tag']),
      intro: z.string(),
      groups: z.array(
        z.object({
          heading: z.string(),
          kind: z.enum(['new', 'milestone', 'fixes', 'upgrade', 'limits', 'checks', 'other']),
          folded: z.boolean(),
          items: z.array(
            z.object({
              lead: z.string().optional(),
              body: z.string(),
              pullRequests: z.array(PullRequest),
            }),
          ),
          paragraphs: z.string(),
        }),
      ),
    }),
  }),
};

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { KnowledgeLocale } from '../knowledge/locale.js';

/**
 * The evaluation set and the fixture knowledge base of DOMAIN-RULES §9
 * (M7-11), read from `packages/ai/eval/`:
 *
 * - `items.json` — the questions, at least {@link MIN_ITEMS_PER_LOCALE} in
 *   English and in Arabic, in the five categories §9 names;
 * - `knowledge/articles.json` — the fixture help center, every article in
 *   both languages;
 * - `knowledge/files/*.txt` — the text of each fixture PDF, one line per PDF
 *   line and `---` between pages; the harness builds the PDF from it so a
 *   reader can see what the file says;
 * - `knowledge/site/` — the pages of the fixture website, served to the
 *   crawler from memory under {@link EVAL_SITE_ORIGIN}.
 *
 * The loader checks the set against the fixture: every expected source names
 * a document the fixture produces, so a typo in a title fails the load, not
 * the nightly run.
 */

export const EVAL_CATEGORIES = [
  'answerable',
  'multi-source',
  'unanswerable',
  'ambiguous',
  'adversarial',
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export const ADVERSARIAL_KINDS = ['injection', 'pii', 'internal'] as const;
export type AdversarialKind = (typeof ADVERSARIAL_KINDS)[number];

/** DOMAIN-RULES §9: "at least 40 English and 40 Arabic items". */
export const MIN_ITEMS_PER_LOCALE = 40;

export const EVAL_SITE_ORIGIN = 'https://www.orbitbikes.example';

/** `packages/ai/eval/`, from `src/eval/` and from `dist/eval/` alike. */
export const EVAL_DIR = fileURLToPath(new URL('../../eval/', import.meta.url));

const localeSchema = z.enum(['en', 'ar']);
const title = z.string().trim().min(1);

const attackSchema = z.object({
  kind: z.enum(ADVERSARIAL_KINDS),
  /** Text the answer must never contain: an injected payload, an internal code. */
  forbidden: z.array(title).default([]),
  /** Text that must never reach the provider: the PII in the question. */
  secrets: z.array(title).default([]),
});

export const evalItemSchema = z
  .object({
    id: z.string().regex(/^(?:en|ar)-[a-z]+-\d{2}$/, 'ids look like en-ans-01'),
    locale: localeSchema,
    category: z.enum(EVAL_CATEGORIES),
    question: z.string().trim().min(1),
    /** Titles of the documents a correct answer cites. */
    expectedSources: z.array(title).default([]),
    /** What a correct answer states; the judge reads them as meaning. */
    keyFacts: z.array(title).default([]),
    attack: attackSchema.optional(),
  })
  .superRefine((item, context) => {
    const grounded = item.category === 'answerable' || item.category === 'multi-source';
    if (grounded && (item.expectedSources.length === 0 || item.keyFacts.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: `${item.id}: an ${item.category} item needs expected sources and key facts`,
      });
    }
    if (item.category === 'multi-source' && item.expectedSources.length < 2) {
      context.addIssue({
        code: 'custom',
        message: `${item.id}: a multi-source item needs at least two expected sources`,
      });
    }
    if ((item.category === 'adversarial') !== (item.attack !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: `${item.id}: exactly the adversarial items describe an attack`,
      });
    }
    if (!item.id.startsWith(`${item.locale}-`)) {
      context.addIssue({ code: 'custom', message: `${item.id}: the id names another locale` });
    }
  });

export type EvalItem = z.infer<typeof evalItemSchema>;

const itemsFileSchema = z.object({
  $comment: z.string().optional(),
  items: z.array(evalItemSchema).min(1),
});

const versionSchema = z.object({ title, bodyHtml: z.string().min(1) });

export const fixtureArticleSchema = z.object({
  slug: z.string().min(1),
  visibility: z.enum(['public', 'internal']),
  versions: z.object({ en: versionSchema, ar: versionSchema }),
});
export type FixtureArticle = z.infer<typeof fixtureArticleSchema>;

const names = z.object({ en: title, ar: title });

export const fixtureCategorySchema = z.object({
  slug: z.string().min(1),
  names,
  sections: z.array(
    z.object({ slug: z.string().min(1), names, articles: z.array(fixtureArticleSchema).min(1) }),
  ),
});
export type FixtureCategory = z.infer<typeof fixtureCategorySchema>;

const articlesFileSchema = z.object({
  $comment: z.string().optional(),
  categories: z.array(fixtureCategorySchema).min(1),
});

export interface FixtureFile {
  /** The PDF's file name, whose stem is the document's title. */
  readonly fileName: string;
  readonly pages: readonly (readonly string[])[];
}

export interface FixtureSite {
  readonly origin: string;
  /** Path (`/en/models.html`) to the body served there. */
  readonly pages: ReadonlyMap<string, string>;
}

export interface EvalFixture {
  readonly categories: readonly FixtureCategory[];
  readonly files: readonly FixtureFile[];
  readonly site: FixtureSite;
}

export interface EvalSuite {
  readonly items: readonly EvalItem[];
  readonly fixture: EvalFixture;
  /** Every document title the fixture produces, per locale. */
  readonly documentTitles: ReadonlySet<string>;
}

export class EvalSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSuiteError';
  }
}

const PAGE_BREAK = /^---$/m;

/** The pages of a fixture PDF from its text file: lines, with `---` between pages. */
export const pdfPagesOf = (text: string): string[][] =>
  text
    .split(PAGE_BREAK)
    .map((page) =>
      page
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line !== ''),
    )
    .filter((page) => page.length > 0);

const titleOf = (html: string): string | null => {
  const match = /<title>([^<]*)<\/title>/i.exec(html);
  return match?.[1]?.trim() || null;
};

const walk = async (root: string, dir = root): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? walk(root, path.join(dir, entry.name))
        : Promise.resolve([path.relative(root, path.join(dir, entry.name))]),
    ),
  );
  return files.flat().sort();
};

export const loadEvalFixture = async (dir = EVAL_DIR): Promise<EvalFixture> => {
  const knowledge = path.join(dir, 'knowledge');
  const { categories } = articlesFileSchema.parse(
    JSON.parse(await readFile(path.join(knowledge, 'articles.json'), 'utf8')),
  );

  const filesDir = path.join(knowledge, 'files');
  const files = await Promise.all(
    (await readdir(filesDir))
      .filter((name) => name.endsWith('.txt'))
      .sort()
      .map(async (name) => ({
        fileName: `${name.replace(/\.txt$/, '')}.pdf`,
        pages: pdfPagesOf(await readFile(path.join(filesDir, name), 'utf8')),
      })),
  );

  const siteDir = path.join(knowledge, 'site');
  const pages = new Map<string, string>();
  for (const relative of await walk(siteDir)) {
    pages.set(
      `/${relative.split(path.sep).join('/')}`,
      await readFile(path.join(siteDir, relative), 'utf8'),
    );
  }

  return { categories, files, site: { origin: EVAL_SITE_ORIGIN, pages } };
};

/** Every title ingest will give a fixture document: article versions, PDFs, crawled pages. */
export const fixtureDocumentTitles = (fixture: EvalFixture): Set<string> => {
  const titles = new Set<string>();
  for (const category of fixture.categories) {
    for (const section of category.sections) {
      for (const article of section.articles) {
        titles.add(article.versions.en.title);
        titles.add(article.versions.ar.title);
      }
    }
  }
  for (const file of fixture.files) {
    titles.add(file.fileName.replace(/\.[^.]+$/, ''));
  }
  for (const [route, body] of fixture.site.pages) {
    const pageTitle = route.endsWith('.html') ? titleOf(body) : null;
    if (pageTitle !== null) {
      titles.add(pageTitle);
    }
  }
  return titles;
};

/** The rules the set must meet before a run means anything; throws the first broken one. */
export const validateEvalItems = (
  items: readonly EvalItem[],
  documentTitles: ReadonlySet<string>,
): void => {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new EvalSuiteError(`duplicate item id ${item.id}`);
    }
    ids.add(item.id);
    for (const source of item.expectedSources) {
      if (!documentTitles.has(source)) {
        throw new EvalSuiteError(
          `${item.id} expects "${source}", which no fixture document is titled`,
        );
      }
    }
  }
  for (const locale of ['en', 'ar'] as const satisfies readonly KnowledgeLocale[]) {
    const ofLocale = items.filter((item) => item.locale === locale);
    if (ofLocale.length < MIN_ITEMS_PER_LOCALE) {
      throw new EvalSuiteError(
        `${String(ofLocale.length)} ${locale} items; DOMAIN-RULES §9 asks for at least ${String(MIN_ITEMS_PER_LOCALE)}`,
      );
    }
    for (const category of EVAL_CATEGORIES) {
      if (!ofLocale.some((item) => item.category === category)) {
        throw new EvalSuiteError(`no ${category} item in ${locale}`);
      }
    }
  }
};

export const loadEvalSuite = async (dir = EVAL_DIR): Promise<EvalSuite> => {
  const { items } = itemsFileSchema.parse(
    JSON.parse(await readFile(path.join(dir, 'items.json'), 'utf8')),
  );
  const fixture = await loadEvalFixture(dir);
  const documentTitles = fixtureDocumentTitles(fixture);
  validateEvalItems(items, documentTitles);
  return { items, fixture, documentTitles };
};

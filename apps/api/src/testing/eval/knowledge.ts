import {
  type Ai,
  type CrawlFetch,
  type EvalFixture,
  type EvalKnowledgeCounts,
  type FixtureSite,
  minimalPdf,
} from '@helpdock/ai';
import { createKeyring } from '@helpdock/config';
import { knowledgeChunks, knowledgeDocuments } from '@helpdock/db';
import type {
  HcArticle,
  HcCategory,
  HcSection,
  KnowledgeFilePresignResponse,
  KnowledgeSourceView,
} from '@helpdock/schemas';
import { and, count, eq } from 'drizzle-orm';
import { readOAuthApps } from '../../knowledge/credentials.js';
import { configureEmbeddingSpace, reembedChunks } from '../../knowledge/embedding-space.job.js';
import { KnowledgeRepository } from '../../knowledge/knowledge.repository.js';
import { knowledgeFileKey } from '../../knowledge/load-source.js';
import { runSourceSync } from '../../knowledge/sync.job.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { silentJobLogger } from '../media.js';
import type { EvalStack, StaffResponse } from './stack.js';

/**
 * The fixture knowledge base into the evaluation install (M7-11), the way an
 * admin would load it: the help center through its routes, article by
 * article in both languages; the PDF presigned, put in the bucket and
 * confirmed; the website as a crawl source read from memory; then "Sync now"
 * on each source, which chunks, screens for injections (M7-08) and embeds.
 */

const EVAL_JOB = 'ai-eval';
const CRAWL_MAX_PAGES = 50;

const contentTypeOf = (route: string): string => {
  if (route.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (route.endsWith('.xml')) {
    return 'application/xml';
  }
  return 'text/plain; charset=utf-8';
};

/** The fixture website, served to the crawler without a network. */
export const fixtureCrawlFetch =
  (site: FixtureSite): CrawlFetch =>
  (url) => {
    const parsed = new URL(url);
    const body = parsed.origin === site.origin ? site.pages.get(parsed.pathname) : undefined;
    return Promise.resolve(
      body === undefined
        ? { status: 404, contentType: 'text/plain', body: 'not found', url }
        : { status: 200, contentType: contentTypeOf(parsed.pathname), body, url },
    );
  };

const ok = <T>(response: StaffResponse<T>, what: string): T => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `${what} answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
};

export interface LoadKnowledgeOptions {
  readonly stack: EvalStack;
  readonly fixture: EvalFixture;
  /** Embeds; the model settings are already written. */
  readonly ai: Pick<Ai, 'embed'>;
}

const loadHelpCenter = async ({ stack, fixture }: LoadKnowledgeOptions): Promise<void> => {
  const base = `/api/brands/${stack.brandId}/help-center`;
  for (const category of fixture.categories) {
    const created = ok(
      await stack.staff<HcCategory>('POST', `${base}/categories`, { names: category.names }),
      `creating category ${category.slug}`,
    );
    for (const section of category.sections) {
      const createdSection = ok(
        await stack.staff<HcSection>('POST', `${base}/sections`, {
          categoryId: created.id,
          names: section.names,
        }),
        `creating section ${section.slug}`,
      );
      for (const article of section.articles) {
        const createdArticle = ok(
          await stack.staff<HcArticle>('POST', `${base}/articles`, {
            sectionId: createdSection.id,
            locale: 'en',
            title: article.versions.en.title,
          }),
          `creating article ${article.slug}`,
        );
        for (const locale of ['en', 'ar'] as const) {
          const version = article.versions[locale];
          const versionUrl = `${base}/articles/${createdArticle.id}/versions/${locale}`;
          ok(
            await stack.staff('PUT', versionUrl, {
              title: version.title,
              description: '',
              bodyHtml: version.bodyHtml,
            }),
            `writing ${article.slug} (${locale})`,
          );
          if (article.visibility === 'internal') {
            ok(
              await stack.staff('PUT', `${versionUrl}/visibility`, { visibility: 'internal' }),
              `hiding ${article.slug} (${locale})`,
            );
          }
          ok(
            await stack.staff('PUT', `${versionUrl}/status`, { status: 'published' }),
            `publishing ${article.slug} (${locale})`,
          );
        }
      }
    }
  }
};

const sync = async (
  { stack, fixture, ai }: LoadKnowledgeOptions,
  sourceId: string,
  what: string,
): Promise<void> => {
  const { runtime, storage } = stack;
  const outcome = await runSourceSync(
    {
      db: runtime.db,
      ai,
      loaders: {
        storage,
        crawlFetch: fixtureCrawlFetch(fixture.site),
        renderer: null,
        fetch,
        keyring: createKeyring(runtime.env),
        oauthApps: () => readOAuthApps(runtime.settings),
      },
      log: silentJobLogger,
    },
    { brandId: stack.brandId, sourceId, trigger: 'manual' },
    `${EVAL_JOB}.sync.${sourceId}`,
  );
  if (outcome !== 'synced') {
    throw new Error(`syncing ${what} ended ${outcome}`);
  }
};

const loadFiles = async (options: LoadKnowledgeOptions): Promise<void> => {
  const { stack, fixture } = options;
  for (const file of fixture.files) {
    const bytes = minimalPdf(file.pages);
    const presigned = ok(
      await stack.staff<KnowledgeFilePresignResponse>(
        'POST',
        `/api/brands/${stack.brandId}/knowledge/files`,
        {
          fileName: file.fileName,
          mime: 'application/pdf',
          size: bytes.length,
          visibility: 'public',
        },
      ),
      `presigning ${file.fileName}`,
    );
    await stack.storage.put(knowledgeFileKey(stack.brandId, presigned.sourceId), bytes);
    ok(
      await stack.staff(
        'POST',
        `/api/brands/${stack.brandId}/knowledge/sources/${presigned.sourceId}/confirm`,
      ),
      `confirming ${file.fileName}`,
    );
    await sync(options, presigned.sourceId, file.fileName);
  }
};

const loadSite = async (options: LoadKnowledgeOptions): Promise<void> => {
  const { stack, fixture } = options;
  const source = ok(
    await stack.staff<KnowledgeSourceView>(
      'POST',
      `/api/brands/${stack.brandId}/knowledge/sources`,
      {
        kind: 'crawl',
        name: 'Website',
        visibility: 'public',
        schedule: 'manual',
        config: {
          mode: 'sitemap',
          url: `${fixture.site.origin}/sitemap.xml`,
          maxPages: CRAWL_MAX_PAGES,
          include: [],
          exclude: [],
        },
      },
    ),
    'creating the crawl source',
  );
  await sync(options, source.id, 'the website');
};

const syncArticles = async (options: LoadKnowledgeOptions): Promise<void> => {
  const { stack } = options;
  const source = await withSystemJob(stack.runtime.db, stack.brandId, EVAL_JOB, (tx) =>
    new KnowledgeRepository().articleSource(tx, stack.brandId),
  );
  await sync(options, source.id, 'the help center');
};

const countKnowledge = ({ stack }: LoadKnowledgeOptions): Promise<EvalKnowledgeCounts> =>
  withSystemJob(stack.runtime.db, stack.brandId, EVAL_JOB, async (tx) => {
    const [documents] = await tx
      .select({ n: count() })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.brandId, stack.brandId));
    const [chunks] = await tx
      .select({ n: count() })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.brandId, stack.brandId));
    const [suspicious] = await tx
      .select({ n: count() })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.brandId, stack.brandId), eq(knowledgeChunks.suspicious, true)));
    return { documents: documents?.n ?? 0, chunks: chunks?.n ?? 0, suspicious: suspicious?.n ?? 0 };
  });

export const loadEvalKnowledge = async (
  options: LoadKnowledgeOptions,
): Promise<EvalKnowledgeCounts> => {
  const { stack, ai } = options;
  await configureEmbeddingSpace({
    db: stack.runtime.db,
    settings: stack.runtime.settings,
    queue: { add: async () => undefined },
  });
  await reembedChunks({ db: stack.runtime.db, ai, jobId: `${EVAL_JOB}.reembed` });
  await loadHelpCenter(options);
  await syncArticles(options);
  await loadFiles(options);
  await loadSite(options);
  return countKnowledge(options);
};

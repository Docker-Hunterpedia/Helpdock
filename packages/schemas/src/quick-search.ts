import { z } from 'zod';
import { localeSchema } from './brand.js';

/**
 * M14-05: the command palette's one read, `GET /api/brands/:brandId/quick-search`.
 *
 * Three sections come back in one request, each judged on its own: a section
 * the person may not read is `skipped`, one that errored or ran past its
 * budget is `failed` (the palette says so and offers a retry while the others
 * still show), and one that answered is `ok` with at most `limit` items.
 */

export const QUICK_SEARCH_LIMIT_DEFAULT = 5;
export const QUICK_SEARCH_LIMIT_MAX = 10;
export const QUICK_SEARCH_QUERY_MAX = 200;

export const quickSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(QUICK_SEARCH_QUERY_MAX),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(QUICK_SEARCH_LIMIT_MAX)
    .default(QUICK_SEARCH_LIMIT_DEFAULT),
  /** The language articles are looked up in first; the brand's default is the fallback. */
  locale: localeSchema.default('en'),
});
export type QuickSearchQuery = z.infer<typeof quickSearchQuerySchema>;

export const quickSearchTicketSchema = z.object({
  id: z.uuid(),
  number: z.int().positive(),
  /** The brand's prefix, so the reference reads `HD-1042`. */
  prefix: z.string().min(1),
  subject: z.string(),
});
export type QuickSearchTicket = z.infer<typeof quickSearchTicketSchema>;

export const quickSearchContactSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** The verified email if there is one, else the first identifier; null when they hold none. */
  identity: z.string().nullable(),
});
export type QuickSearchContact = z.infer<typeof quickSearchContactSchema>;

export const quickSearchArticleSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  /** `published` is what readers see; the others are a draft's title, for who may manage articles. */
  status: z.enum(['published', 'draft', 'scheduled']),
});
export type QuickSearchArticle = z.infer<typeof quickSearchArticleSchema>;

const sectionSchema = <Item extends z.ZodType>(item: Item) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), items: z.array(item) }),
    z.object({ status: z.literal('skipped') }),
    z.object({ status: z.literal('failed') }),
  ]);

export const quickSearchSchema = z.object({
  tickets: sectionSchema(quickSearchTicketSchema),
  contacts: sectionSchema(quickSearchContactSchema),
  articles: sectionSchema(quickSearchArticleSchema),
});
export type QuickSearch = z.infer<typeof quickSearchSchema>;
export type QuickSearchSection<Item> =
  | { status: 'ok'; items: Item[] }
  | { status: 'skipped' }
  | { status: 'failed' };

import { z } from 'zod';
import { localeSchema } from './brand.js';

/**
 * Help center search, feedback and insights (M5-05, M5-08; REQUIREMENTS §4.5).
 *
 * - **Search** is logged: query, language, where it came from and how many
 *   articles it found, so the Insights tab can show what visitors look for and
 *   what the help center does not answer yet. The log is kept for the brand's
 *   search log window (DOMAIN-RULES §11, 180 days by default).
 * - **Feedback** is one "Was this helpful?" answer per visitor per article
 *   version (one language of one article); a second answer replaces the first.
 *   A "No" may carry an optional comment.
 * - **Views** count once per visitor per article per day.
 */

/** The longest query anybody is searched or logged for; the rest is cut off. */
export const HC_SEARCH_QUERY_MAX = 200;
/** One page of hits at most. */
export const HC_SEARCH_LIMIT_MAX = 50;
/** An optional comment on a "No". */
export const HC_FEEDBACK_COMMENT_MAX = 1_000;

export const hcSearchSourceSchema = z.enum(['help_center', 'widget']);
export type HcSearchSource = z.infer<typeof hcSearchSourceSchema>;

/** A vote as the help center page posts it (M5-08). */
export const hcVoteRequestSchema = z.object({
  helpful: z.boolean(),
  comment: z.string().trim().max(HC_FEEDBACK_COMMENT_MAX).optional(),
});
export type HcVoteRequest = z.infer<typeof hcVoteRequestSchema>;

// ------------------------------------------------------------- insights

/** The Insights tab's period select: 7, 30 or 90 days. */
export const HC_INSIGHTS_PERIODS = [7, 30, 90] as const;
export const hcInsightsPeriodSchema = z.coerce
  .number()
  .int()
  .refine((days) => (HC_INSIGHTS_PERIODS as readonly number[]).includes(days), {
    message: 'must be 7, 30 or 90',
  });

export const hcInsightsSortSchema = z.enum(['views', 'least_helpful']);
export type HcInsightsSort = z.infer<typeof hcInsightsSortSchema>;

/** `GET /api/brands/:brandId/help-center/insights`. */
export const hcInsightsQuerySchema = z.object({
  days: hcInsightsPeriodSchema.default(30),
  /** Absent: every language. */
  locale: localeSchema.optional(),
  sort: hcInsightsSortSchema.default('views'),
});
export type HcInsightsQuery = z.infer<typeof hcInsightsQuerySchema>;

/** How many rows each table of the tab holds. */
export const HC_INSIGHTS_ROWS = 10;
export const HC_INSIGHTS_ARTICLE_ROWS = 20;

export const hcTopSearchSchema = z.object({
  query: z.string(),
  locale: localeSchema,
  searches: z.int().nonnegative(),
  /** Share of these searches after which the visitor opened a hit, 0 to 1. */
  openedRate: z.number().min(0).max(1),
});
export type HcTopSearch = z.infer<typeof hcTopSearchSchema>;

export const hcZeroResultSearchSchema = z.object({
  query: z.string(),
  locale: localeSchema,
  searches: z.int().nonnegative(),
  lastSearchedAt: z.iso.datetime(),
});
export type HcZeroResultSearch = z.infer<typeof hcZeroResultSearchSchema>;

export const hcArticleStatsSchema = z.object({
  articleId: z.uuid(),
  title: z.string(),
  views: z.int().nonnegative(),
  /** "Yes" answers. */
  helpful: z.int().nonnegative(),
  /** Every answer, "Yes" and "No". */
  votes: z.int().nonnegative(),
  /** Answers that carried a comment. */
  comments: z.int().nonnegative(),
});
export type HcArticleStats = z.infer<typeof hcArticleStatsSchema>;

export const hcInsightsSchema = z.object({
  days: z.int(),
  locale: localeSchema.nullable(),
  topSearches: z.array(hcTopSearchSchema),
  zeroResultSearches: z.array(hcZeroResultSearchSchema),
  articles: z.array(hcArticleStatsSchema),
});
export type HcInsights = z.infer<typeof hcInsightsSchema>;

import type {
  HcArticle as HcArticleRow,
  HcCategory as HcCategoryRow,
  HcSection as HcSectionRow,
} from '@helpdock/db';
import type {
  HcArticleSummary,
  HcCategory,
  HcSection,
  HcVersion,
  HcVersionSummary,
} from '@helpdock/schemas';
import type { VersionRow } from './help-center.repository.js';

/** The rows as the admin reads them. Nothing here decides anything. */

const both = (names: Record<string, string>) => ({ en: names.en ?? '', ar: names.ar ?? '' });

export const toCategory = (row: HcCategoryRow): HcCategory => ({
  id: row.id,
  slug: row.slug,
  names: both(row.names),
  descriptions: both(row.descriptions),
  position: row.position,
});

export const toSection = (row: HcSectionRow): HcSection => ({
  id: row.id,
  categoryId: row.categoryId,
  slug: row.slug,
  names: both(row.names),
  position: row.position,
});

/**
 * Whether the working copy differs from what visitors read. A version never
 * published has nothing to differ from, so it has no *unpublished changes* —
 * it is unpublished altogether, which its status says.
 */
export const hasUnpublishedChanges = (row: VersionRow): boolean =>
  row.publishedAt !== null &&
  (row.title !== row.publishedTitle ||
    row.description !== row.publishedDescription ||
    row.bodyHtml !== row.publishedBodyHtml);

export const toVersionSummary = (row: VersionRow): HcVersionSummary => ({
  locale: row.locale,
  status: row.status,
  visibility: row.visibility,
  title: row.title,
  scheduledAt: row.scheduledAt?.toISOString() ?? null,
  publishedAt: row.publishedAt?.toISOString() ?? null,
  updatedAt: row.updatedAt.toISOString(),
  updatedByName: row.updatedByName,
  hasUnpublishedChanges: hasUnpublishedChanges(row),
});

export const toVersion = (row: VersionRow): HcVersion => ({
  ...toVersionSummary(row),
  description: row.description,
  bodyHtml: row.bodyHtml,
  publishedByName: row.publishedByName,
});

export const toArticleSummary = (
  row: HcArticleRow,
  versions: readonly VersionRow[],
): HcArticleSummary => ({
  id: row.id,
  sectionId: row.sectionId,
  slug: row.slug,
  position: row.position,
  versions: versions.map(toVersionSummary),
});

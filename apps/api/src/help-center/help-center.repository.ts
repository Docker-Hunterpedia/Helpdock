import {
  brands,
  type DbTransaction,
  type HcArticle,
  type HcArticleVersion,
  type HcCategory,
  type HcSection,
  hcArticles,
  hcArticleVersions,
  hcCategories,
  hcSections,
  hcSettings,
  type NewHcArticleVersion,
  users,
} from '@helpdock/db';
import type { HcAccess, HcLocale } from '@helpdock/schemas';
import { and, asc, count, eq, inArray, isNotNull, lte, max, sql } from 'drizzle-orm';

/**
 * Every statement the help center admin makes (M5-01, M5-02, M5-09).
 *
 * None filters by brand: the transaction carries `app.brand_ids` and the
 * policies on every `hc_*` table apply it, so another brand's row is simply
 * not found. Every method takes the transaction, as `MacrosRepository` does.
 */

/** A version and the name of whoever last saved it, for the list and the editor. */
export interface VersionRow extends HcArticleVersion {
  readonly updatedByName: string | null;
  readonly publishedByName: string | null;
}

type Parent = 'categories' | 'sections' | 'articles';

const first = <T>(rows: readonly T[]): T => {
  const [row] = rows;
  /* c8 ignore next 3 -- an insert or update that did not throw returned its row. */
  if (row === undefined) {
    throw new Error('The statement returned no row');
  }
  return row;
};

export class HelpCenterRepository {
  async brandFacts(
    tx: DbTransaction,
    brandId: string,
  ): Promise<{ defaultLocale: HcLocale; timezone: string }> {
    const [row] = await tx
      .select({ defaultLocale: brands.defaultLocale, timezone: brands.timezone })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    return row ?? { defaultLocale: 'en', timezone: 'UTC' };
  }

  categories(tx: DbTransaction): Promise<HcCategory[]> {
    return tx.select().from(hcCategories).orderBy(asc(hcCategories.position), asc(hcCategories.id));
  }

  sections(tx: DbTransaction): Promise<HcSection[]> {
    return tx.select().from(hcSections).orderBy(asc(hcSections.position), asc(hcSections.id));
  }

  articles(tx: DbTransaction): Promise<HcArticle[]> {
    return tx.select().from(hcArticles).orderBy(asc(hcArticles.position), asc(hcArticles.id));
  }

  /** Every version, or one article's, with the names of who saved and published it. */
  async versions(tx: DbTransaction, articleId?: string): Promise<VersionRow[]> {
    const publisher = sql<
      string | null
    >`(select name from users p where p.id = ${hcArticleVersions.publishedBy})`;
    const rows = await tx
      .select({ version: hcArticleVersions, updatedByName: users.name, publishedByName: publisher })
      .from(hcArticleVersions)
      .leftJoin(users, eq(users.id, hcArticleVersions.updatedBy))
      .where(articleId === undefined ? undefined : eq(hcArticleVersions.articleId, articleId))
      .orderBy(asc(hcArticleVersions.locale));

    return rows.map((row) => ({
      ...row.version,
      updatedByName: row.updatedByName,
      publishedByName: row.publishedByName,
    }));
  }

  async category(tx: DbTransaction, id: string): Promise<HcCategory | undefined> {
    const [row] = await tx.select().from(hcCategories).where(eq(hcCategories.id, id)).limit(1);
    return row;
  }

  async section(tx: DbTransaction, id: string): Promise<HcSection | undefined> {
    const [row] = await tx.select().from(hcSections).where(eq(hcSections.id, id)).limit(1);
    return row;
  }

  async article(tx: DbTransaction, id: string): Promise<HcArticle | undefined> {
    const [row] = await tx.select().from(hcArticles).where(eq(hcArticles.id, id)).limit(1);
    return row;
  }

  async version(
    tx: DbTransaction,
    articleId: string,
    locale: HcLocale,
  ): Promise<HcArticleVersion | undefined> {
    const [row] = await tx
      .select()
      .from(hcArticleVersions)
      .where(and(eq(hcArticleVersions.articleId, articleId), eq(hcArticleVersions.locale, locale)))
      .limit(1);
    return row;
  }

  async count(tx: DbTransaction, what: Parent): Promise<number> {
    const table = { categories: hcCategories, sections: hcSections, articles: hcArticles }[what];
    const [row] = await tx.select({ value: count() }).from(table);
    return row?.value ?? 0;
  }

  /** The position after the last child of a parent, so a new row lands at the end. */
  async nextPosition(tx: DbTransaction, what: Parent, parentId: string | null): Promise<number> {
    const [row] =
      what === 'categories'
        ? await tx.select({ value: max(hcCategories.position) }).from(hcCategories)
        : what === 'sections'
          ? await tx
              .select({ value: max(hcSections.position) })
              .from(hcSections)
              .where(eq(hcSections.categoryId, parentId ?? ''))
          : await tx
              .select({ value: max(hcArticles.position) })
              .from(hcArticles)
              .where(eq(hcArticles.sectionId, parentId ?? ''));
    return (row?.value ?? -1) + 1;
  }

  /** Whether a slug is taken among one kind of row, other than by `exceptId`. */
  async slugTaken(
    tx: DbTransaction,
    what: Parent,
    slug: string,
    exceptId?: string,
  ): Promise<boolean> {
    const table = { categories: hcCategories, sections: hcSections, articles: hcArticles }[what];
    const rows = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.slug, slug),
          exceptId === undefined ? undefined : sql`${table.id} <> ${exceptId}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  insertCategory(tx: DbTransaction, values: typeof hcCategories.$inferInsert) {
    return tx.insert(hcCategories).values(values).returning().then(first);
  }

  updateCategory(tx: DbTransaction, id: string, values: Partial<typeof hcCategories.$inferInsert>) {
    return tx
      .update(hcCategories)
      .set(values)
      .where(eq(hcCategories.id, id))
      .returning()
      .then(first);
  }

  async deleteCategory(tx: DbTransaction, id: string): Promise<void> {
    await tx.delete(hcCategories).where(eq(hcCategories.id, id));
  }

  insertSection(tx: DbTransaction, values: typeof hcSections.$inferInsert) {
    return tx.insert(hcSections).values(values).returning().then(first);
  }

  updateSection(tx: DbTransaction, id: string, values: Partial<typeof hcSections.$inferInsert>) {
    return tx.update(hcSections).set(values).where(eq(hcSections.id, id)).returning().then(first);
  }

  async deleteSection(tx: DbTransaction, id: string): Promise<void> {
    await tx.delete(hcSections).where(eq(hcSections.id, id));
  }

  async hasSections(tx: DbTransaction, categoryId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: hcSections.id })
      .from(hcSections)
      .where(eq(hcSections.categoryId, categoryId))
      .limit(1);
    return rows.length > 0;
  }

  async hasArticles(tx: DbTransaction, sectionId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: hcArticles.id })
      .from(hcArticles)
      .where(eq(hcArticles.sectionId, sectionId))
      .limit(1);
    return rows.length > 0;
  }

  insertArticle(tx: DbTransaction, values: typeof hcArticles.$inferInsert) {
    return tx.insert(hcArticles).values(values).returning().then(first);
  }

  updateArticle(tx: DbTransaction, id: string, values: Partial<typeof hcArticles.$inferInsert>) {
    return tx.update(hcArticles).set(values).where(eq(hcArticles.id, id)).returning().then(first);
  }

  async deleteArticle(tx: DbTransaction, id: string): Promise<void> {
    await tx.delete(hcArticles).where(eq(hcArticles.id, id));
  }

  async everPublished(tx: DbTransaction, articleId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: hcArticleVersions.id })
      .from(hcArticleVersions)
      .where(
        and(eq(hcArticleVersions.articleId, articleId), isNotNull(hcArticleVersions.publishedAt)),
      )
      .limit(1);
    return rows.length > 0;
  }

  insertVersion(tx: DbTransaction, values: NewHcArticleVersion) {
    return tx.insert(hcArticleVersions).values(values).returning().then(first);
  }

  updateVersion(tx: DbTransaction, id: string, values: Partial<NewHcArticleVersion>) {
    return tx
      .update(hcArticleVersions)
      .set(values)
      .where(eq(hcArticleVersions.id, id))
      .returning()
      .then(first);
  }

  /** A slug or section change moves what every language is read at. */
  async touchVersions(tx: DbTransaction, articleId: string, at: Date): Promise<void> {
    await tx
      .update(hcArticleVersions)
      .set({ changedAt: at, updatedAt: sql`${hcArticleVersions.updatedAt}` })
      .where(eq(hcArticleVersions.articleId, articleId));
  }

  /** Versions whose scheduled time has come, oldest first. */
  dueVersions(tx: DbTransaction, now: Date): Promise<HcArticleVersion[]> {
    return tx
      .select()
      .from(hcArticleVersions)
      .where(
        and(eq(hcArticleVersions.status, 'scheduled'), lte(hcArticleVersions.scheduledAt, now)),
      )
      .orderBy(asc(hcArticleVersions.scheduledAt), asc(hcArticleVersions.id));
  }

  /** Sets the order of one parent's children, and moves any child named from elsewhere. */
  async reorder(
    tx: DbTransaction,
    what: Parent,
    parentId: string | null,
    ids: readonly string[],
  ): Promise<void> {
    // One statement per row: a brand has at most a few hundred children under
    // one parent, and each update is by primary key.
    for (const [position, id] of ids.entries()) {
      if (what === 'categories') {
        await tx.update(hcCategories).set({ position }).where(eq(hcCategories.id, id));
      } else if (what === 'sections') {
        await tx
          .update(hcSections)
          .set({ position, categoryId: parentId ?? undefined })
          .where(eq(hcSections.id, id));
      } else {
        await tx
          .update(hcArticles)
          .set({ position, sectionId: parentId ?? undefined })
          .where(eq(hcArticles.id, id));
      }
    }
  }

  /** How many of `ids` exist in this brand. */
  async existing(tx: DbTransaction, what: Parent, ids: readonly string[]): Promise<HcIdRow[]> {
    if (what === 'categories') {
      return tx
        .select({ id: hcCategories.id, parentId: sql<string | null>`null` })
        .from(hcCategories)
        .where(inArray(hcCategories.id, [...ids]));
    }
    if (what === 'sections') {
      return tx
        .select({ id: hcSections.id, parentId: hcSections.categoryId })
        .from(hcSections)
        .where(inArray(hcSections.id, [...ids]));
    }
    return tx
      .select({ id: hcArticles.id, parentId: hcArticles.sectionId })
      .from(hcArticles)
      .where(inArray(hcArticles.id, [...ids]));
  }

  async access(tx: DbTransaction, brandId: string): Promise<HcAccess> {
    const [row] = await tx
      .select({ access: hcSettings.access })
      .from(hcSettings)
      .where(eq(hcSettings.brandId, brandId))
      .limit(1);
    return row?.access ?? 'public';
  }

  async setAccess(
    tx: DbTransaction,
    brandId: string,
    access: HcAccess,
    updatedBy: string,
  ): Promise<void> {
    await tx
      .insert(hcSettings)
      .values({ brandId, access, updatedBy })
      .onConflictDoUpdate({ target: hcSettings.brandId, set: { access, updatedBy } });
  }
}

export interface HcIdRow {
  readonly id: string;
  readonly parentId: string | null;
}

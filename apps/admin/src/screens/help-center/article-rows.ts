import type {
  HcArticleStatus,
  HcArticleSummary,
  HcLocale,
  HcStructure,
  HcVersionSummary,
  HcVisibility,
} from '@helpdock/schemas';

/**
 * What the Articles tab (`Admin/HelpCenter`) derives from the structure: one
 * row per article with the language it is shown in, the filters, counts and
 * breadcrumbs. Pure functions, so the rules the list follows are tested
 * without drawing it.
 */

export type LanguageFilter = 'any' | 'missing_ar' | 'missing_en';

export interface ArticleFilters {
  readonly q: string;
  readonly status: HcArticleStatus | 'any';
  readonly visibility: HcVisibility | 'any';
  readonly language: LanguageFilter;
  readonly sectionId: string | null;
}

export const NO_FILTERS: ArticleFilters = {
  q: '',
  status: 'any',
  visibility: 'any',
  language: 'any',
  sectionId: null,
};

export const HC_LOCALES: readonly HcLocale[] = ['en', 'ar'];

/** The name in `locale`, else in the other language: a category named in Arabic alone still has a name. */
export const nameIn = (
  names: { readonly en: string; readonly ar: string },
  locale: HcLocale,
): string => names[locale] || names[locale === 'en' ? 'ar' : 'en'];

/**
 * The version a row speaks for: the brand's default language when it has
 * one, since that is what a visitor without a translation reads, else the
 * first there is.
 */
export const primaryVersion = (
  article: HcArticleSummary,
  defaultLocale: HcLocale,
): HcVersionSummary | undefined =>
  article.versions.find((version) => version.locale === defaultLocale) ?? article.versions[0];

/** The title in the reader's language when it exists, else the primary one's. */
export const titleOf = (
  article: HcArticleSummary,
  locale: HcLocale,
  defaultLocale: HcLocale,
): string =>
  article.versions.find((version) => version.locale === locale)?.title ??
  primaryVersion(article, defaultLocale)?.title ??
  article.slug;

const hasLocale = (article: HcArticleSummary, locale: HcLocale): boolean =>
  article.versions.some((version) => version.locale === locale);

/** The articles that pass every filter, in the tree's order: category, section, position. */
export const filterArticles = (
  structure: HcStructure,
  filters: ArticleFilters,
): HcArticleSummary[] => {
  const q = filters.q.trim().toLocaleLowerCase();
  const order = sectionOrder(structure);

  return structure.articles
    .filter((article) => filters.sectionId === null || article.sectionId === filters.sectionId)
    .filter(
      (article) =>
        q === '' ||
        article.versions.some((version) => version.title.toLocaleLowerCase().includes(q)),
    )
    .filter((article) => {
      const primary = primaryVersion(article, structure.defaultLocale);
      return (
        (filters.status === 'any' || primary?.status === filters.status) &&
        (filters.visibility === 'any' || primary?.visibility === filters.visibility)
      );
    })
    .filter((article) =>
      filters.language === 'missing_ar'
        ? !hasLocale(article, 'ar')
        : filters.language === 'missing_en'
          ? !hasLocale(article, 'en')
          : true,
    )
    .sort(
      (a, b) =>
        (order.get(a.sectionId) ?? 0) - (order.get(b.sectionId) ?? 0) || a.position - b.position,
    );
};

/** Each section's place in the whole tree, categories first. */
const sectionOrder = (structure: HcStructure): Map<string, number> => {
  const categories = new Map(
    structure.categories.map((category) => [category.id, category.position]),
  );
  const sorted = [...structure.sections].sort(
    (a, b) =>
      (categories.get(a.categoryId) ?? 0) - (categories.get(b.categoryId) ?? 0) ||
      a.position - b.position,
  );
  return new Map(sorted.map((section, index) => [section.id, index]));
};

/** "Returns & refunds › Refunds" for a section, in the reader's language. */
export const breadcrumb = (structure: HcStructure, sectionId: string, locale: HcLocale): string => {
  const section = structure.sections.find((candidate) => candidate.id === sectionId);
  const category = structure.categories.find((candidate) => candidate.id === section?.categoryId);
  return [category, section]
    .filter((part) => part !== undefined)
    .map((part) => nameIn(part.names, locale))
    .join(' › ');
};

export interface TreeCounts {
  readonly bySection: ReadonlyMap<string, number>;
  readonly byCategory: ReadonlyMap<string, number>;
}

export const countArticles = (structure: HcStructure): TreeCounts => {
  const bySection = new Map<string, number>();
  for (const article of structure.articles) {
    bySection.set(article.sectionId, (bySection.get(article.sectionId) ?? 0) + 1);
  }
  const byCategory = new Map<string, number>();
  for (const section of structure.sections) {
    byCategory.set(
      section.categoryId,
      (byCategory.get(section.categoryId) ?? 0) + (bySection.get(section.id) ?? 0),
    );
  }
  return { bySection, byCategory };
};

/** The children of one parent, in order. */
export const sectionsOf = (structure: HcStructure, categoryId: string) =>
  structure.sections
    .filter((section) => section.categoryId === categoryId)
    .sort((a, b) => a.position - b.position);

export const articlesOf = (structure: HcStructure, sectionId: string) =>
  structure.articles
    .filter((article) => article.sectionId === sectionId)
    .sort((a, b) => a.position - b.position);

export const orderedCategories = (structure: HcStructure) =>
  [...structure.categories].sort((a, b) => a.position - b.position);

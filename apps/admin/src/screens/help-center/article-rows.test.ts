import { describe, expect, it } from 'vitest';
import { MOCK_HELP_CENTER, MockHelpCenterApi } from '../../help-center/mock-api.js';
import {
  articlesOf,
  breadcrumb,
  countArticles,
  filterArticles,
  NO_FILTERS,
  nameIn,
  orderedCategories,
  primaryVersion,
  sectionsOf,
  titleOf,
} from './article-rows.js';

const M = MOCK_HELP_CENTER;
const structure = await new MockHelpCenterApi().structure();
const titles = (filters: Partial<typeof NO_FILTERS>) =>
  filterArticles(structure, { ...NO_FILTERS, ...filters }).map((row) =>
    titleOf(row, 'en', structure.defaultLocale),
  );

describe('the article list’s rules', () => {
  it('lists every article in the tree’s order, category first', () => {
    expect(titles({})[0]).toBe('Where is my order?');
    expect(titles({})).toHaveLength(structure.articles.length);
  });

  it('narrows by section, title, status, visibility and missing language', () => {
    expect(titles({ sectionId: M.sections.refunds })).toHaveLength(6);
    expect(titles({ q: 'REFUND EXC' })).toEqual(['Refund exceptions: who approves what']);
    expect(titles({ q: 'مواعيد' })).toEqual(['Refund timelines']);
    expect(titles({ status: 'scheduled' })).toEqual(['Partial refunds for bundles']);
    expect(titles({ visibility: 'internal' })).toEqual(['Refund exceptions: who approves what']);
    expect(titles({ language: 'missing_ar' })).toEqual([
      'Where is my order?',
      'Refunds to a closed or expired card',
      'How we calculate restocking fees',
    ]);
    expect(titles({ language: 'missing_en' })).toEqual([]);
  });

  it('shows a row by the default language’s version and titles it in the reader’s', () => {
    const timelines = structure.articles.find((row) => row.id === M.articles.timelines);
    if (timelines === undefined) {
      throw new Error('the fixture has no timelines article');
    }

    expect(primaryVersion(timelines, 'en')?.status).toBe('published');
    expect(primaryVersion(timelines, 'ar')?.status).toBe('scheduled');
    expect(titleOf(timelines, 'ar', 'en')).toBe('مواعيد استرداد المبالغ');
    expect(titleOf({ ...timelines, versions: [] }, 'ar', 'en')).toBe(timelines.slug);
  });

  it('names a place in the reader’s language, falling back to the other', () => {
    expect(breadcrumb(structure, M.sections.refunds, 'ar')).toBe(
      'المرتجعات والاسترداد › المبالغ المستردة',
    );
    expect(nameIn({ en: '', ar: 'الحساب' }, 'en')).toBe('الحساب');
    expect(breadcrumb(structure, 'missing', 'en')).toBe('');
  });

  it('counts articles per section and per category, and orders children', () => {
    const counts = countArticles(structure);

    expect(counts.bySection.get(M.sections.refunds)).toBe(6);
    expect(counts.byCategory.get(M.categories.returns)).toBe(6);
    expect(orderedCategories(structure).map((row) => row.id)[0]).toBe(M.categories.orders);
    expect(sectionsOf(structure, M.categories.returns).map((row) => row.id)).toEqual([
      M.sections.starting,
      M.sections.refunds,
      M.sections.damaged,
    ]);
    expect(articlesOf(structure, M.sections.refunds)[0]?.id).toBe(M.articles.timelines);
  });
});

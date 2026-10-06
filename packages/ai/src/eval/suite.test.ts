import { describe, expect, it } from 'vitest';
import {
  type EvalItem,
  EvalSuiteError,
  evalItemSchema,
  fixtureDocumentTitles,
  loadEvalSuite,
  MIN_ITEMS_PER_LOCALE,
  pdfPagesOf,
  validateEvalItems,
} from './suite.js';

const item = (overrides: Partial<EvalItem> = {}): EvalItem => ({
  id: 'en-ans-01',
  locale: 'en',
  category: 'answerable',
  question: 'How long does delivery take?',
  expectedSources: ['Shipping'],
  keyFacts: ['3 to 5 days'],
  ...overrides,
});

const fortyOf = (locale: 'en' | 'ar'): EvalItem[] => {
  const categories = [
    'answerable',
    'multi-source',
    'unanswerable',
    'ambiguous',
    'adversarial',
  ] as const;
  return Array.from({ length: MIN_ITEMS_PER_LOCALE }, (_, index) => {
    const category = categories[index % categories.length] ?? 'answerable';
    const grounded = category === 'answerable' || category === 'multi-source';
    return item({
      id: `${locale}-mix-${String(index).padStart(2, '0')}`,
      locale,
      category,
      expectedSources: grounded ? ['Shipping', 'Returns'] : [],
      keyFacts: grounded ? ['a fact'] : [],
      ...(category === 'adversarial'
        ? { attack: { kind: 'injection' as const, forbidden: ['X'], secrets: [] } }
        : {}),
    });
  });
};

describe('the shipped evaluation set', () => {
  it('loads, meets §9’s minimums and names only fixture documents', async () => {
    const suite = await loadEvalSuite();
    const en = suite.items.filter((entry) => entry.locale === 'en');
    const ar = suite.items.filter((entry) => entry.locale === 'ar');
    expect(en.length).toBeGreaterThanOrEqual(MIN_ITEMS_PER_LOCALE);
    expect(ar.length).toBeGreaterThanOrEqual(MIN_ITEMS_PER_LOCALE);
    expect(suite.fixture.files.map((file) => file.fileName)).toEqual(['Warranty and repairs.pdf']);
    expect(suite.fixture.site.pages.has('/sitemap.xml')).toBe(true);
    expect(suite.documentTitles.has('Orbit models')).toBe(true);
    expect(suite.documentTitles.has('طرازات Orbit')).toBe(true);
  });

  it('covers the three adversarial kinds in both languages', async () => {
    const { items } = await loadEvalSuite();
    for (const locale of ['en', 'ar'] as const) {
      const kinds = new Set(
        items
          .filter((entry) => entry.locale === locale && entry.attack !== undefined)
          .map((entry) => entry.attack?.kind),
      );
      expect([...kinds].sort()).toEqual(['injection', 'internal', 'pii']);
    }
  });
});

describe('evalItemSchema', () => {
  it('requires sources and facts on an answerable item', () => {
    expect(evalItemSchema.safeParse(item({ expectedSources: [] })).success).toBe(false);
    expect(evalItemSchema.safeParse(item({ keyFacts: [] })).success).toBe(false);
  });

  it('requires two sources on a multi-source item', () => {
    expect(
      evalItemSchema.safeParse(item({ id: 'en-multi-01', category: 'multi-source' })).success,
    ).toBe(false);
    expect(
      evalItemSchema.safeParse(
        item({ id: 'en-multi-01', category: 'multi-source', expectedSources: ['A', 'B'] }),
      ).success,
    ).toBe(true);
  });

  it('ties the attack to the adversarial category and the id to the locale', () => {
    expect(
      evalItemSchema.safeParse(item({ attack: { kind: 'pii', forbidden: [], secrets: [] } }))
        .success,
    ).toBe(false);
    expect(
      evalItemSchema.safeParse(item({ id: 'en-adv-01', category: 'adversarial' })).success,
    ).toBe(false);
    expect(evalItemSchema.safeParse(item({ locale: 'ar' })).success).toBe(false);
  });
});

describe('validateEvalItems', () => {
  const titles = new Set(['Shipping', 'Returns']);

  it('accepts a set with forty items per language in every category', () => {
    expect(() => validateEvalItems([...fortyOf('en'), ...fortyOf('ar')], titles)).not.toThrow();
  });

  it('rejects a duplicate id', () => {
    expect(() => validateEvalItems([item(), item()], titles)).toThrow(EvalSuiteError);
  });

  it('rejects an expected source no document is titled', () => {
    expect(() => validateEvalItems([item({ expectedSources: ['Shiping'] })], titles)).toThrow(
      /no fixture document is titled/,
    );
  });

  it('rejects too few items in a language', () => {
    expect(() => validateEvalItems(fortyOf('en'), titles)).toThrow(/0 ar items/);
  });

  it('rejects a language missing a category', () => {
    const without = fortyOf('en').map((entry) =>
      entry.category === 'ambiguous' ? { ...entry, category: 'unanswerable' as const } : entry,
    );
    expect(() => validateEvalItems([...without, ...fortyOf('ar')], titles)).toThrow(
      /no ambiguous item in en/,
    );
  });
});

describe('pdfPagesOf', () => {
  it('splits pages on --- and drops blank lines', () => {
    expect(pdfPagesOf('Title\n\nLine one  \n---\nPage two\n')).toEqual([
      ['Title', 'Line one'],
      ['Page two'],
    ]);
  });
});

describe('fixtureDocumentTitles', () => {
  it('collects article versions, PDF stems and page titles', () => {
    const titles = fixtureDocumentTitles({
      categories: [
        {
          slug: 'c',
          names: { en: 'C', ar: 'ج' },
          sections: [
            {
              slug: 's',
              names: { en: 'S', ar: 'س' },
              articles: [
                {
                  slug: 'a',
                  visibility: 'public',
                  versions: {
                    en: { title: 'Shipping', bodyHtml: '<p>x</p>' },
                    ar: { title: 'الشحن', bodyHtml: '<p>x</p>' },
                  },
                },
              ],
            },
          ],
        },
      ],
      files: [{ fileName: 'Warranty.pdf', pages: [['x']] }],
      site: {
        origin: 'https://x.example',
        pages: new Map([
          ['/en/a.html', '<html><head><title> Stores </title></head></html>'],
          ['/robots.txt', 'User-agent: *'],
        ]),
      },
    });
    expect([...titles].sort()).toEqual(['Shipping', 'Stores', 'Warranty', 'الشحن']);
  });
});

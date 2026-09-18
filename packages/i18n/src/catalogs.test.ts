import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAMESPACES, SUPPORTED_LNGS } from './resources.js';

const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../locales');

/**
 * `zero`, `two`, `few` and `many` only exist in some languages; i18next asks
 * `Intl.PluralRules` which of them a locale uses.
 */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const PLURAL_PATTERN = new RegExp(`_(${PLURAL_SUFFIXES.join('|')})$`);

const ENGLISH_PLURAL_FORMS = ['one', 'other'];
const ARABIC_PLURAL_FORMS = [...PLURAL_SUFFIXES];

type Catalog = Record<string, unknown>;

function flatten(value: Catalog, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();

  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') {
      flat.set(dotted, child);
    } else if (child && typeof child === 'object') {
      for (const [nested, text] of flatten(child as Catalog, dotted)) {
        flat.set(nested, text);
      }
    } else {
      throw new Error(`${dotted} is neither a string nor an object`);
    }
  }

  return flat;
}

async function readCatalog(locale: string, namespace: string): Promise<Map<string, string>> {
  const file = path.join(localesDir, locale, `${namespace}.json`);

  return flatten(JSON.parse(await readFile(file, 'utf8')) as Catalog);
}

/** The base key of a plural set: `peopleCount_other` and `peopleCount` alike. */
const baseKey = (key: string): string => key.replace(PLURAL_PATTERN, '');
const isPlural = (key: string): boolean => PLURAL_PATTERN.test(key);

const formsFor = (keys: Iterable<string>, base: string): string[] =>
  [...keys]
    .filter((key) => isPlural(key) && baseKey(key) === base)
    .map((key) => key.slice(base.length + 1))
    .sort();

const catalogs = new Map<string, Map<string, string>>();
for (const locale of SUPPORTED_LNGS) {
  for (const namespace of NAMESPACES) {
    catalogs.set(`${locale}/${namespace}`, await readCatalog(locale, namespace));
  }
}

const keysOf = (locale: string, namespace: string): Map<string, string> => {
  const catalog = catalogs.get(`${locale}/${namespace}`);
  if (!catalog) {
    throw new Error(`no catalog for ${locale}/${namespace}`);
  }

  return catalog;
};

describe('catalog files', () => {
  it.each(SUPPORTED_LNGS)('%s has exactly the declared namespaces', async (locale) => {
    const files = (await readdir(path.join(localesDir, locale))).sort();

    expect(files).toEqual([...NAMESPACES].map((namespace) => `${namespace}.json`).sort());
  });
});

describe.each(NAMESPACES)('%s namespace', (namespace) => {
  const en = keysOf('en', namespace);
  const ar = keysOf('ar', namespace);

  const baseKeys = (catalog: Map<string, string>): string[] =>
    [...new Set([...catalog.keys()].map(baseKey))].sort();

  it('has the same keys in en and ar', () => {
    expect(baseKeys(ar)).toEqual(baseKeys(en));
  });

  it.each(SUPPORTED_LNGS)('has no empty string in %s', (locale) => {
    const empty = [...keysOf(locale, namespace)]
      .filter(([, text]) => text.trim() === '')
      .map(([key]) => key);

    expect(empty).toEqual([]);
  });

  /**
   * `count` is excluded: a plural form may spell the number out — Arabic's
   * dual is "شخصان", English's is "one other brand" — and then the placeholder
   * is correctly absent. The `_other` form is checked for it below.
   */
  it('keeps the same interpolation placeholders in both languages', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)]
        .map(([, name = '']) => name)
        .filter((name) => name !== 'count')
        .sort();

    for (const [key, english] of en) {
      const arabic = ar.get(key) ?? ar.get(`${baseKey(key)}_other`);
      if (!arabic) {
        continue;
      }

      expect(placeholders(arabic), `${namespace}:${key}`).toEqual(placeholders(english));
    }
  });

  it('interpolates the count in the catch-all plural form of both languages', () => {
    for (const base of new Set([...en.keys(), ...ar.keys()].filter(isPlural).map(baseKey))) {
      expect(en.get(`${base}_other`), `en ${namespace}:${base}`).toContain('{{count}}');
      expect(ar.get(`${base}_other`), `ar ${namespace}:${base}`).toContain('{{count}}');
    }
  });

  it('gives English both plural forms', () => {
    for (const base of new Set([...en.keys()].filter(isPlural).map(baseKey))) {
      expect(formsFor(en.keys(), base), `${namespace}:${base}`).toEqual(ENGLISH_PLURAL_FORMS);
    }
  });

  it('gives Arabic all six plural forms for every plural key', () => {
    const pluralBases = new Set([...en.keys(), ...ar.keys()].filter(isPlural).map(baseKey));

    for (const base of pluralBases) {
      expect(formsFor(ar.keys(), base), `${namespace}:${base}`).toEqual(
        [...ARABIC_PLURAL_FORMS].sort(),
      );
    }
  });
});

describe('the catalogs as a whole', () => {
  it('carries at least one plural key, so the rules above are exercised', () => {
    const plurals = [...catalogs.values()].flatMap((catalog) =>
      [...catalog.keys()].filter(isPlural),
    );

    expect(plurals.length).toBeGreaterThan(0);
  });

  /**
   * The reference screens were drawn with a placeholder brand before the sample
   * brand became Helpdock. A catalog string is shipped copy, so a leftover
   * placeholder would reach an installer's screen.
   */
  it('carries no leftover placeholder brand', () => {
    const offenders: string[] = [];

    for (const [catalogName, catalog] of catalogs) {
      for (const [key, text] of catalog) {
        if (/swapforless|SFL-/i.test(text)) {
          offenders.push(`${catalogName}:${key}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never leaves an English string in the Arabic catalogs', () => {
    const untranslated: string[] = [];

    for (const namespace of NAMESPACES) {
      const en = keysOf('en', namespace);
      for (const [key, arabic] of keysOf('ar', namespace)) {
        const english = en.get(key);
        // Brand names, product names and technical placeholders are the same in
        // both languages, so only Latin-script prose counts as untranslated.
        if (english && english === arabic && /[a-z]{4,}\s+[a-z]{4,}/i.test(english)) {
          untranslated.push(`${namespace}:${key}`);
        }
      }
    }

    expect(untranslated).toEqual([]);
  });
});

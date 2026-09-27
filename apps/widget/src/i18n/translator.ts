import type { WidgetLocale } from '../transport/types.js';

/**
 * A translator over the `widget` namespace of `@helpdock/i18n`, reading the
 * same i18next JSON catalogs with the same rules: nested keys, `{{name}}`
 * interpolation, and plural keys suffixed `_one`, `_other`, … chosen by
 * `Intl.PluralRules` from `count`. It is not i18next itself because i18next
 * alone would spend a third of the widget's 40 KB budget (ADR 0012).
 */
export type Catalog = { readonly [key: string]: string | Catalog };
export type Vars = Readonly<Record<string, string | number>>;
export type Translate = (key: string, vars?: Vars) => string;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function lookup(catalog: Catalog, key: string): string | Catalog | undefined {
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

export function createTranslator(catalog: Catalog, locale: WidgetLocale): Translate {
  const plurals = new Intl.PluralRules(locale);

  return (key, vars = {}) => {
    const count = vars.count;
    const text =
      (typeof count === 'number'
        ? lookup(catalog, `${key}_${plurals.select(count)}`)
        : undefined) ??
      (typeof count === 'number' ? lookup(catalog, `${key}_other`) : undefined) ??
      lookup(catalog, key);

    if (typeof text !== 'string') {
      // A missing key is a bug the catalog test should have caught; showing the
      // key keeps the widget usable and makes the gap obvious.
      return key;
    }

    return text.replace(PLACEHOLDER, (match, name: string) =>
      name in vars ? String(vars[name]) : match,
    );
  };
}

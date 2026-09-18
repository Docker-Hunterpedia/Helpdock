import { createInstance, type i18n, type Resource } from 'i18next';
import {
  DEFAULT_NS,
  FALLBACK_LNG,
  type Locale,
  NAMESPACES,
  resources,
  SUPPORTED_LNGS,
} from './resources.js';
import './types.js';

export type TextDirection = 'ltr' | 'rtl';

const RTL_LANGUAGES = new Set(['ar']);

/**
 * The `dir` attribute for a locale. Everything downstream — `<html dir>`, the
 * Emotion cache in `@helpdock/ui`, the widget's Shadow DOM host — reads this
 * one function so the direction can never disagree with the language.
 */
export function dir(lng: string): TextDirection {
  const [language = ''] = lng.toLowerCase().split('-');

  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

export interface CreateI18nOptions {
  readonly lng?: Locale;
  /** Replaces the bundled catalogs. Tests and Storybook use this. */
  readonly resources?: Resource;
}

/**
 * A ready i18next instance, configured once for every Helpdock app. It is its
 * own instance rather than the i18next singleton so the api can hold one per
 * request while rendering the help center.
 */
export function createI18n({
  lng = FALLBACK_LNG,
  resources: catalogs = resources,
}: CreateI18nOptions = {}): i18n {
  const instance = createInstance();

  void instance.init({
    lng,
    fallbackLng: FALLBACK_LNG,
    supportedLngs: [...SUPPORTED_LNGS],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NS,
    resources: catalogs,
    returnNull: false,
    // Everything is bundled, so there is nothing to await: the instance is
    // usable the moment this function returns, on the server and in tests.
    initAsync: false,
    interpolation: {
      // React and Preact escape what they render, and no Helpdock code passes
      // a translation to `innerHTML`. Escaping here would double-encode.
      escapeValue: false,
    },
  });

  return instance;
}

export type { CatalogShape, Locale, Namespace, Resources } from './resources.js';
export {
  DEFAULT_NS,
  FALLBACK_LNG,
  NAMESPACES,
  resources,
  SUPPORTED_LNGS,
} from './resources.js';

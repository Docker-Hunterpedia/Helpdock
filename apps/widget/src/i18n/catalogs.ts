import ar from '@helpdock/i18n/locales/ar/widget.json';
import en from '@helpdock/i18n/locales/en/widget.json';
import type { WidgetLocale } from '../transport/types.js';
import { type Catalog, createTranslator, type Translate } from './translator.js';

/** Both catalogs are bundled: first paint in either language needs no second request. */
const CATALOGS: Record<WidgetLocale, Catalog> = { en, ar };

export function translatorFor(locale: WidgetLocale): Translate {
  return createTranslator(CATALOGS[locale], locale);
}

export function direction(locale: WidgetLocale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/** The page's language when it is one we ship, otherwise the brand's default. */
export function pickLocale(
  requested: string | null | undefined,
  fallback: WidgetLocale,
): WidgetLocale {
  const language = (requested ?? '').toLowerCase().split('-')[0];
  return language === 'en' || language === 'ar' ? language : fallback;
}

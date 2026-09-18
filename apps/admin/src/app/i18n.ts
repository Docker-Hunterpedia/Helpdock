import { FALLBACK_LNG, type Locale, NAMESPACES, SUPPORTED_LNGS } from '@helpdock/i18n';
import { useTranslation } from 'react-i18next';

/**
 * Helpdock ships two languages, so both the sign-in link and the account menu
 * offer "the other one" rather than a list. One rule, in one place, for the day
 * a third language makes this a list instead.
 */
export function otherLocale(locale: Locale): Locale {
  return SUPPORTED_LNGS.find((candidate) => candidate !== locale) ?? FALLBACK_LNG;
}

/**
 * `t` with every namespace loaded, so a screen writes `t('auth:signIn.title')`
 * and the key is checked against the English catalogs. Plain `useTranslation()`
 * would type-check only the default namespace and reject the prefixed keys the
 * catalogs are organised around.
 */
export function useT(): ReturnType<typeof useTranslation<typeof NAMESPACES>>['t'] {
  return useTranslation(NAMESPACES).t;
}

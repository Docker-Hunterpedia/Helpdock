import { createI18n, type Locale } from '@helpdock/i18n';

/**
 * The bot's wording, from one i18next instance for the whole process: the
 * catalogs are bundled, so a fixed `t` per locale is all a message needs, and
 * building an instance per inbound update or outbound notice was waste.
 */

const i18n = createI18n();

/** `t` over the `telegram` catalog, for the bot's replies and notices. */
export const telegramText = (locale: Locale) => i18n.getFixedT(locale, 'telegram');

/** `t` over the `telegram` and `csat` catalogs, for the survey's keyboard and words. */
export const telegramCsatText = (locale: Locale) =>
  i18n.getFixedT(locale, ['telegram', 'csat'] as const);

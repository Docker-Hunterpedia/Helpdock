import type { TelegramBot } from '@helpdock/db';
import { createI18n, defaultLanguagePrompt, type Locale } from '@helpdock/i18n';

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

const filled = (text: string | null): text is string => text !== null && text.trim() !== '';

/**
 * M6-04: what `/start` asks before the contact's language is known, so it
 * names both: the bot's own text when it has one, else the catalog's.
 */
export const languagePromptText = (bot: Pick<TelegramBot, 'languagePrompt'>): string =>
  filled(bot.languagePrompt) ? bot.languagePrompt : defaultLanguagePrompt();

/** M6-04: the bot's own welcome for the language, else the catalog's in that language. */
export const welcomeText = (
  bot: Pick<TelegramBot, 'welcomeEn' | 'welcomeAr'>,
  locale: Locale,
): string => {
  const own = locale === 'ar' ? bot.welcomeAr : bot.welcomeEn;
  return filled(own) ? own : telegramText(locale)('bot.welcome');
};

/** M6-04: "Language: English" in the chosen language, what the prompt is rewritten to. */
export const languageChosenText = (locale: Locale): string =>
  telegramText(locale)('bot.languageChosen');

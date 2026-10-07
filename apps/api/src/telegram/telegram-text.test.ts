import { describe, expect, it } from 'vitest';
import { telegramCsatText, telegramText } from './telegram-text.js';

describe('the bot wording', () => {
  it('answers in the locale asked for, from the one shared instance', () => {
    const en = telegramText('en')('bot.languagePrompt');
    const ar = telegramText('ar')('bot.languagePrompt');

    expect(en).not.toBe('bot.languagePrompt');
    expect(ar).not.toBe('bot.languagePrompt');
    expect(ar).not.toBe(en);
    expect(telegramText('en')('bot.languagePrompt')).toBe(en);
  });

  it('reaches the survey catalog beside the bot catalog', () => {
    expect(telegramCsatText('en')('csat.addComment')).not.toBe('csat.addComment');
    expect(telegramCsatText('ar')('csat:ratings.5')).not.toBe('csat:ratings.5');
  });
});

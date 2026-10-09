import { describe, expect, it } from 'vitest';
import {
  languageChosenText,
  languagePromptText,
  telegramCsatText,
  telegramText,
  welcomeText,
} from './telegram-text.js';

const bot = (fields: {
  languagePrompt?: string | null;
  welcomeEn?: string | null;
  welcomeAr?: string | null;
}) => ({ languagePrompt: null, welcomeEn: null, welcomeAr: null, ...fields });

describe('the bot wording', () => {
  it('answers in the locale asked for, from the one shared instance', () => {
    const en = telegramText('en')('bot.welcome');
    const ar = telegramText('ar')('bot.welcome');

    expect(en).not.toBe('bot.welcome');
    expect(ar).not.toBe('bot.welcome');
    expect(ar).not.toBe(en);
    expect(telegramText('en')('bot.welcome')).toBe(en);
  });

  it('reaches the survey catalog beside the bot catalog', () => {
    expect(telegramCsatText('en')('csat.addComment')).not.toBe('csat.addComment');
    expect(telegramCsatText('ar')('csat:ratings.5')).not.toBe('csat:ratings.5');
  });
});

describe('the language prompt (M6-04)', () => {
  it('is the bot’s own text when it has one', () => {
    expect(languagePromptText(bot({ languagePrompt: 'Pick a language · اختر لغتك' }))).toBe(
      'Pick a language · اختر لغتك',
    );
  });

  it('is the catalog’s when the bot has none, or only blanks', () => {
    expect(languagePromptText(bot({}))).toBe('Choose your language · اختر لغتك');
    expect(languagePromptText(bot({ languagePrompt: '   ' }))).toBe(
      'Choose your language · اختر لغتك',
    );
  });
});

describe('the welcome (M6-04)', () => {
  it('is the bot’s own text for the language, and never the other language’s', () => {
    const own = bot({ welcomeEn: 'Welcome to Acme.', welcomeAr: 'أهلًا بك في أكمي.' });

    expect(welcomeText(own, 'en')).toBe('Welcome to Acme.');
    expect(welcomeText(own, 'ar')).toBe('أهلًا بك في أكمي.');
  });

  it('is the catalog’s in that language when the bot has none for it', () => {
    const onlyEnglish = bot({ welcomeEn: 'Welcome to Acme.' });

    expect(welcomeText(onlyEnglish, 'ar')).toBe(telegramText('ar')('bot.welcome'));
    expect(welcomeText(bot({ welcomeEn: '  ' }), 'en')).toBe(telegramText('en')('bot.welcome'));
  });
});

describe('the line that replaces the prompt once a language is chosen', () => {
  it('names the choice in its own language', () => {
    expect(languageChosenText('en')).toBe('Language: English');
    expect(languageChosenText('ar')).toBe('اللغة: العربية');
  });
});

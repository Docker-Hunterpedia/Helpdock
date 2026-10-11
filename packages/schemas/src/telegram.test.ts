import { describe, expect, it } from 'vitest';
import {
  parseTelegramLanguageCallback,
  TELEGRAM_LANGUAGE_PROMPT_MAX_LENGTH,
  telegramBotCreateRequestSchema,
  telegramBotHealth,
  telegramBotUpdateRequestSchema,
  telegramLanguageCallback,
  telegramWebhookPath,
} from './telegram.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const DEPARTMENT = '01924f00-0000-7000-8000-0000000000aa';

describe('telegramBotHealth', () => {
  const earlier = new Date('2026-10-05T10:00:00Z');
  const later = new Date('2026-10-05T11:00:00Z');

  it('waits until the first update arrives', () => {
    expect(telegramBotHealth({ lastUpdateAt: null, lastErrorAt: null })).toBe('waiting');
  });

  it('is healthy once an update arrived after the last error', () => {
    expect(telegramBotHealth({ lastUpdateAt: later, lastErrorAt: earlier })).toBe('healthy');
  });

  it('is failing when the newest event is an error, received or not', () => {
    expect(telegramBotHealth({ lastUpdateAt: earlier, lastErrorAt: later })).toBe('failing');
    expect(telegramBotHealth({ lastUpdateAt: null, lastErrorAt: later })).toBe('failing');
  });
});

describe('the bot form', () => {
  it('accepts a BotFather token and fills the defaults', () => {
    expect(
      telegramBotCreateRequestSchema.parse({
        displayName: ' Acme ',
        departmentId: DEPARTMENT,
        token: TOKEN,
      }),
    ).toEqual({
      displayName: 'Acme',
      departmentId: DEPARTMENT,
      token: TOKEN,
      welcomeEn: null,
      welcomeAr: null,
      languagePrompt: null,
      languagePick: true,
    });
  });

  it('keeps a language prompt as typed, trimmed, and null for the catalog’s', () => {
    const base = { displayName: 'Acme', departmentId: DEPARTMENT };

    expect(
      telegramBotUpdateRequestSchema.parse({
        ...base,
        languagePrompt: '  Pick a language · اختر لغتك ',
      }).languagePrompt,
    ).toBe('Pick a language · اختر لغتك');
    expect(telegramBotUpdateRequestSchema.parse({ ...base }).languagePrompt).toBeNull();
    expect(
      telegramBotUpdateRequestSchema.parse({ ...base, languagePrompt: null }).languagePrompt,
    ).toBeNull();
  });

  it('refuses a language prompt past the limit, and accepts one at it', () => {
    const base = { displayName: 'Acme', departmentId: DEPARTMENT, token: TOKEN };
    const at = 'x'.repeat(TELEGRAM_LANGUAGE_PROMPT_MAX_LENGTH);

    expect(telegramBotCreateRequestSchema.safeParse({ ...base, languagePrompt: at }).success).toBe(
      true,
    );
    expect(
      telegramBotCreateRequestSchema.safeParse({ ...base, languagePrompt: `${at}x` }).success,
    ).toBe(false);
  });

  it('refuses something that is not a token', () => {
    const result = telegramBotCreateRequestSchema.safeParse({
      displayName: 'Acme',
      departmentId: DEPARTMENT,
      token: 'not-a-token',
    });
    expect(result.success).toBe(false);
  });

  it('keeps the stored token when an update carries none', () => {
    const parsed = telegramBotUpdateRequestSchema.parse({
      displayName: 'Acme',
      departmentId: DEPARTMENT,
    });
    expect(parsed.token).toBeUndefined();
  });
});

describe('the language callback', () => {
  it('round-trips both languages', () => {
    expect(parseTelegramLanguageCallback(telegramLanguageCallback('en'))).toBe('en');
    expect(parseTelegramLanguageCallback(telegramLanguageCallback('ar'))).toBe('ar');
  });

  it('ignores anything else', () => {
    expect(parseTelegramLanguageCallback('lang:fr')).toBeUndefined();
    expect(parseTelegramLanguageCallback('lang:en;drop')).toBeUndefined();
  });
});

it('names the webhook route of one bot', () => {
  expect(telegramWebhookPath(DEPARTMENT)).toBe(`/api/telegram/${DEPARTMENT}/webhook`);
});

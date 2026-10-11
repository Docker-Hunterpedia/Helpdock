import {
  TELEGRAM_LANGUAGE_PROMPT_MAX_LENGTH,
  TELEGRAM_WELCOME_MAX_LENGTH,
  type TelegramBot,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { MOCK_SUPPORT_BOT, MockTelegramApi } from '../../../../telegram/mock-api.js';
import { draftFromBot, isDraftDirty, looksLikeToken, validateDraft } from './bot-draft.js';

const bot = async (): Promise<TelegramBot> => new MockTelegramApi().bot('brand', MOCK_SUPPORT_BOT);

describe('the Telegram bot draft', () => {
  it('starts from the saved bot with the token kept', async () => {
    const saved = draftFromBot(await bot());

    expect(saved).toMatchObject({ languagePick: true, token: null });
    expect(saved.welcomeEn).toMatch(/^Hi! This is Helpdock support/);
    expect(isDraftDirty(saved, saved)).toBe(false);
  });

  it('is dirty after any change, and after Replace even before a token is typed', async () => {
    const saved = draftFromBot(await bot());

    expect(isDraftDirty({ ...saved, languagePick: false }, saved)).toBe(true);
    expect(isDraftDirty({ ...saved, welcomeAr: 'أهلا' }, saved)).toBe(true);
    expect(isDraftDirty({ ...saved, languagePrompt: 'Pick one' }, saved)).toBe(true);
    expect(isDraftDirty({ ...saved, departmentId: 'other' }, saved)).toBe(true);
    expect(isDraftDirty({ ...saved, token: '' }, saved)).toBe(true);
  });

  it('sends empty welcomes as null and a replaced token trimmed', async () => {
    const saved = draftFromBot(await bot());
    const token = '7310042215:AAEreplacementTokenAbcdefghijklmnopq';

    const checked = validateDraft(
      { ...saved, welcomeEn: '  ', welcomeAr: ' أهلا ', token: ` ${token} ` },
      'Helpdock Support',
    );

    expect(checked).toEqual({
      ok: true,
      request: {
        displayName: 'Helpdock Support',
        departmentId: saved.departmentId,
        languagePick: true,
        languagePrompt: null,
        welcomeEn: null,
        welcomeAr: 'أهلا',
        token,
      },
    });
  });

  it('shows the catalog’s prompt for a bot without one, and the bot’s own when it has one', async () => {
    const own = { ...(await bot()), languagePrompt: 'Pick a language · اختر لغتك' };

    expect(draftFromBot(await bot()).languagePrompt).toBe('Choose your language · اختر لغتك');
    expect(draftFromBot(own).languagePrompt).toBe('Pick a language · اختر لغتك');
  });

  it.each([
    ['a typed prompt, trimmed', '  Pick a language · اختر لغتك ', 'Pick a language · اختر لغتك'],
    ['nothing', '   ', null],
    ['the catalog’s own text', 'Choose your language · اختر لغتك', null],
  ])('sends %s as the language prompt', async (_case, typed, sent) => {
    const checked = validateDraft(
      { ...draftFromBot(await bot()), languagePrompt: typed },
      'Helpdock Support',
    );

    expect(checked.ok && checked.request.languagePrompt).toBe(sent);
  });

  it('leaves the token out while the saved one is kept', async () => {
    const checked = validateDraft(draftFromBot(await bot()), 'Helpdock Support');

    expect(checked.ok && 'token' in checked.request).toBe(false);
  });

  it('refuses a welcome or a language prompt that is too long and a token that is not BotFather’s', async () => {
    const saved = draftFromBot(await bot());

    expect(
      validateDraft(
        {
          ...saved,
          languagePrompt: 'a'.repeat(TELEGRAM_LANGUAGE_PROMPT_MAX_LENGTH + 1),
          welcomeEn: 'a'.repeat(TELEGRAM_WELCOME_MAX_LENGTH + 1),
          token: 'nope',
        },
        'x',
      ),
    ).toEqual({
      ok: false,
      errors: { languagePrompt: 'tooLong', welcomeEn: 'tooLong', token: 'malformed' },
    });
  });

  it('knows a BotFather token when it sees one', () => {
    expect(looksLikeToken(' 123456789:AAEabcdefghijklmnopqrstuvwxyz0123456 ')).toBe(true);
    expect(looksLikeToken('123456789')).toBe(false);
    expect(looksLikeToken('abc:AAEabcdefghijklmnopqrstuvwxyz0123456')).toBe(false);
  });
});

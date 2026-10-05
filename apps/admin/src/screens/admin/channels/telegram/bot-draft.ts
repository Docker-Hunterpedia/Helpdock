import {
  TELEGRAM_TOKEN_PATTERN,
  TELEGRAM_WELCOME_MAX_LENGTH,
  type TelegramBot,
  type TelegramBotUpdateRequest,
} from '@helpdock/schemas';

/**
 * The bot form of `Admin/Channels-Telegram` (M6-05) as plain data: what the
 * person has typed, whether it differs from what is saved, and the request it
 * becomes. `token` is null while the saved token is kept; Replace makes it a
 * string, which the save sends.
 */
export interface BotDraft {
  readonly departmentId: string;
  readonly languagePick: boolean;
  readonly welcomeEn: string;
  readonly welcomeAr: string;
  readonly token: string | null;
}

export type BotDraftField = 'welcomeEn' | 'welcomeAr' | 'token';
export type BotDraftProblem = 'tooLong' | 'malformed';
export type BotDraftErrors = Partial<Record<BotDraftField, BotDraftProblem>>;

export const draftFromBot = (bot: TelegramBot): BotDraft => ({
  departmentId: bot.departmentId,
  languagePick: bot.languagePick,
  welcomeEn: bot.welcome.en ?? '',
  welcomeAr: bot.welcome.ar ?? '',
  token: null,
});

export const isDraftDirty = (draft: BotDraft, saved: BotDraft): boolean =>
  draft.departmentId !== saved.departmentId ||
  draft.languagePick !== saved.languagePick ||
  draft.welcomeEn !== saved.welcomeEn ||
  draft.welcomeAr !== saved.welcomeAr ||
  draft.token !== null;

/** What BotFather hands out, checked before a round trip to Telegram. */
export const looksLikeToken = (value: string): boolean => TELEGRAM_TOKEN_PATTERN.test(value.trim());

const welcome = (text: string): string | null => (text.trim() === '' ? null : text.trim());

export const validateDraft = (
  draft: BotDraft,
  displayName: string,
):
  | { readonly ok: true; readonly request: TelegramBotUpdateRequest }
  | { readonly ok: false; readonly errors: BotDraftErrors } => {
  const errors: BotDraftErrors = {};
  if (draft.welcomeEn.trim().length > TELEGRAM_WELCOME_MAX_LENGTH) {
    errors.welcomeEn = 'tooLong';
  }
  if (draft.welcomeAr.trim().length > TELEGRAM_WELCOME_MAX_LENGTH) {
    errors.welcomeAr = 'tooLong';
  }
  if (draft.token !== null && !looksLikeToken(draft.token)) {
    errors.token = 'malformed';
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    request: {
      displayName,
      departmentId: draft.departmentId,
      languagePick: draft.languagePick,
      welcomeEn: welcome(draft.welcomeEn),
      welcomeAr: welcome(draft.welcomeAr),
      ...(draft.token === null ? {} : { token: draft.token.trim() }),
    },
  };
};

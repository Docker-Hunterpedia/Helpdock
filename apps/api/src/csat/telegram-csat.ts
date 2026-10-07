import { csatCommentKeyboard, csatKeyboard, type TelegramBotApi } from '@helpdock/channels';
import type { DbTransaction } from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import type { JobLogger, TelegramSendPayload } from '@helpdock/jobs';
import { telegramCsatText } from '../telegram/telegram-text.js';
import type { CsatRepository } from './csat.repository.js';
import { recordCsatAnswer } from './csat-answers.js';
import { type CsatTokens, csatSurveyUrl } from './tokens.js';

/**
 * M8-06's Telegram survey (`Telegram/Chat-EN`, panels 5 and 6).
 *
 * ```
 * close  → outbox(telegram.notice csat_survey)  → the question, 1–5 and Add a comment
 * tap    → csat_responses + csat.received        → outbox(telegram.notice csat_rated)
 *                                                  → thanks; only Add a comment stays
 * late   → nothing recorded                       → outbox(telegram.notice csat_closed)
 *                                                  → "This survey has closed."; buttons gone
 * ```
 *
 * A tap records the score in one go and leaves the link open for a comment.
 * Everything the bot says goes through the outbox like any message to a
 * customer (DOMAIN-RULES §6); the webhook only writes rows.
 */

type Notice = Extract<TelegramSendPayload, { kind: 'notice' }>;

export type CsatTapOutcome = 'rated' | 'closed';

export interface CsatTap {
  readonly brandId: string;
  readonly chatId: string;
  readonly surveyId: string;
  readonly rating: number;
  readonly at: Date;
}

/** The webhook's half: a score button pressed. Runs in the update's system transaction. */
export class CsatTelegramTaps {
  readonly #repository: Pick<CsatRepository, 'findForTelegramChat' | 'rate'>;

  constructor(repository: Pick<CsatRepository, 'findForTelegramChat' | 'rate'>) {
    this.#repository = repository;
  }

  /**
   * `closed` for a survey this chat cannot answer: already answered, expired,
   * or not this chat's at all — the last told apart from the others by nobody,
   * so a guessed id learns nothing.
   */
  async tap(tx: DbTransaction, tap: CsatTap): Promise<CsatTapOutcome> {
    const survey = await this.#repository.findForTelegramChat(tx, tap.surveyId, tap.chatId);
    if (survey === undefined) {
      return 'closed';
    }
    const rated = await recordCsatAnswer(tx, this.#repository, {
      brandId: tap.brandId,
      surveyId: survey.id,
      answer: { rating: tap.rating, comment: null, via: 'telegram', at: tap.at },
    });

    return rated === undefined ? 'closed' : 'rated';
  }
}

const RATING_WORDS = [
  'csat:ratings.1',
  'csat:ratings.2',
  'csat:ratings.3',
  'csat:ratings.4',
  'csat:ratings.5',
] as const;

const dayMonth = (date: Date, locale: Locale): string =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);

/** The worker's half: what the bot says for each `csat_*` notice. */
export class CsatTelegramNotices {
  readonly #repository: Pick<CsatRepository, 'findWithTicket' | 'markSent'>;
  readonly #tokens: CsatTokens;
  readonly #appUrl: string;
  readonly #now: () => Date;

  constructor(options: {
    readonly repository: Pick<CsatRepository, 'findWithTicket' | 'markSent'>;
    readonly tokens: CsatTokens;
    readonly appUrl: string;
    readonly now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#tokens = options.tokens;
    this.#appUrl = options.appUrl;
    this.#now = options.now ?? (() => new Date());
  }

  async send(
    api: TelegramBotApi,
    tx: DbTransaction,
    notice: Notice,
    log: JobLogger,
  ): Promise<void> {
    const found =
      notice.csat === undefined
        ? undefined
        : await this.#repository.findWithTicket(tx, notice.csat.surveyId);
    if (found === undefined) {
      log.info(
        { brandId: notice.brandId, notice: notice.notice },
        'csat notice skipped: no survey',
      );
      return;
    }
    const { survey, reference } = found;
    const words = telegramCsatText(notice.locale);
    const commentUrl = csatSurveyUrl(
      this.#tokens,
      this.#appUrl,
      { brandId: notice.brandId, survey },
      { lang: notice.locale },
    );
    const comment =
      commentUrl === null ? null : { label: words('csat.addComment'), url: commentUrl };

    if (notice.notice === 'csat_survey') {
      if (comment === null) {
        log.info({ brandId: notice.brandId, surveyId: survey.id }, 'csat survey has no link');
        return;
      }
      await api.sendMessage(
        notice.chatId,
        words('csat.survey', { reference }),
        csatKeyboard(survey.id, comment),
      );
      await this.#repository.markSent(tx, survey.id, this.#now());
      return;
    }

    if (notice.callbackQueryId !== undefined) {
      // A press answered late has stopped spinning anyway; what follows still matters.
      await api.answerCallbackQuery(notice.callbackQueryId).catch(() => undefined);
    }
    const messageId = notice.csat?.messageId;
    const rated = notice.notice === 'csat_rated' && notice.csat?.rating !== undefined;
    if (messageId !== undefined) {
      // Cosmetic: Telegram refuses an edit that changes nothing (two taps
      // racing), and the answer below is what the contact needs to read.
      await api
        .editMessageReplyMarkup(
          notice.chatId,
          messageId,
          rated && comment !== null ? csatCommentKeyboard(comment) : undefined,
        )
        .catch(() => undefined);
    }
    const rating = notice.csat?.rating ?? 0;
    await api.sendMessage(
      notice.chatId,
      rated
        ? words('csat.thanks', {
            rating,
            label: words(RATING_WORDS[rating - 1] ?? RATING_WORDS[0]),
            date: dayMonth(survey.expiresAt, notice.locale),
          })
        : words('csat.closed'),
    );
  }
}

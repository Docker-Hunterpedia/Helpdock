import type { TelegramBotApi } from '@helpdock/channels';
import { createKeyring } from '@helpdock/config';
import type { CsatResponse, DbTransaction } from '@helpdock/db';
import { silentLogger, type TelegramSendPayload } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import {
  CSAT_BRAND,
  CSAT_NOW,
  CSAT_SURVEY,
  CSAT_TICKET,
  csatSurveyRow,
} from '../testing/csat-doubles.js';
import { recordingTx } from '../testing/email-doubles.js';
import type { CsatRepository } from './csat.repository.js';
import { CsatTelegramNotices, CsatTelegramTaps } from './telegram-csat.js';
import { CsatTokens, hashCsatToken } from './tokens.js';

const APP_URL = 'https://desk.example.com';
const CHAT = '4242';
const tokens = new CsatTokens(
  createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 6).toString('base64') }),
);
const token = tokens.sign({ brandId: CSAT_BRAND, surveyId: CSAT_SURVEY });

describe('CsatTelegramTaps', () => {
  const tap = (survey: CsatResponse | undefined, open = true) => {
    const recording = recordingTx();
    const taps = new CsatTelegramTaps({
      findForTelegramChat: () => Promise.resolve(survey),
      rate: (_tx, _id, answer) =>
        Promise.resolve(open ? { ...csatSurveyRow(), rating: answer.rating } : undefined),
    });

    return {
      outcome: taps.tap(recording.tx, {
        brandId: CSAT_BRAND,
        chatId: CHAT,
        surveyId: CSAT_SURVEY,
        rating: 4,
        at: CSAT_NOW,
      }),
      outbox: recording.outbox,
    };
  };

  it('records the score in one tap, as a Telegram answer, and emits csat.received', async () => {
    const { outcome, outbox } = tap(csatSurveyRow());

    expect(await outcome).toBe('rated');
    expect(outbox).toEqual([
      expect.objectContaining({
        event: 'csat.received',
        payload: expect.objectContaining({ ticketId: CSAT_TICKET, rating: 4, via: 'telegram' }),
      }),
    ]);
  });

  it('answers closed, recording nothing, for an answered or expired survey', async () => {
    const { outcome, outbox } = tap(csatSurveyRow(), false);

    expect(await outcome).toBe('closed');
    expect(outbox).toEqual([]);
  });

  it('answers closed for a survey that is not this chat’s', async () => {
    expect(await tap(undefined).outcome).toBe('closed');
  });
});

describe('CsatTelegramNotices', () => {
  const setup = () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
        return Promise.resolve('900');
      };
    const api = {
      sendMessage: record('sendMessage'),
      answerCallbackQuery: record('answerCallbackQuery'),
      editMessageReplyMarkup: record('editMessageReplyMarkup'),
    } as unknown as TelegramBotApi;
    const sent: string[] = [];
    const notices = new CsatTelegramNotices({
      repository: {
        findWithTicket: () =>
          Promise.resolve({
            survey: csatSurveyRow({ tokenHash: hashCsatToken(token) }),
            reference: 'HD-1042',
            subject: 'Refund',
          }),
        markSent: (_tx, surveyId) => {
          sent.push(surveyId);
          return Promise.resolve();
        },
      } as Pick<CsatRepository, 'findWithTicket' | 'markSent'>,
      tokens,
      appUrl: APP_URL,
      now: () => CSAT_NOW,
    });
    const send = (
      notice: 'csat_survey' | 'csat_rated' | 'csat_closed',
      locale: 'en' | 'ar' = 'en',
      csat: Extract<TelegramSendPayload, { kind: 'notice' }>['csat'] = { surveyId: CSAT_SURVEY },
    ) =>
      notices.send(
        api,
        {} as DbTransaction,
        {
          kind: 'notice',
          brandId: CSAT_BRAND,
          sourceOutboxId: '0199f4b2-7777-7000-8000-000000000001',
          botId: '0199f4b2-6666-7000-8000-0000000000ff',
          chatId: CHAT,
          notice,
          locale,
          ...(notice === 'csat_survey' ? {} : { callbackQueryId: 'cq-1' }),
          csat,
        },
        silentLogger,
      );

    return { calls, sent, send };
  };
  const commentUrl = (locale: string) => `${APP_URL}/csat/${token}?lang=${locale}`;

  it('asks the question with five score buttons and Add a comment, then counts it sent', async () => {
    const { calls, sent, send } = setup();
    await send('csat_survey');

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        args: [
          CHAT,
          'Your request HD-1042 is closed. How was our help? Tap a number: 1 is very bad, 5 is excellent.',
          {
            inline_keyboard: [
              [1, 2, 3, 4, 5].map((rating) => ({
                text: String(rating),
                callback_data: `csat:${CSAT_SURVEY}:${String(rating)}`,
              })),
              [{ text: 'Add a comment', url: commentUrl('en') }],
            ],
          },
        ],
      },
    ]);
    expect(sent).toEqual([CSAT_SURVEY]);
  });

  it('thanks a tap in the contact’s language, keeping only Add a comment under the survey', async () => {
    const { calls, send } = setup();
    await send('csat_rated', 'ar', { surveyId: CSAT_SURVEY, rating: 4, messageId: '77' });

    expect(calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
      'sendMessage',
    ]);
    expect(calls[1]?.args).toEqual([
      CHAT,
      '77',
      { inline_keyboard: [[{ text: 'أضف تعليقاً', url: commentUrl('ar') }]] },
    ]);
    expect(calls[2]?.args).toEqual([
      CHAT,
      'شكراً! قيّمت هذا الطلب بـ 4 · جيد. يمكنك إضافة تعليق في صفحة الاستبيان حتى 4 نوفمبر.',
    ]);
  });

  it('tells a late tap the survey has closed and takes its buttons away', async () => {
    const { calls, send } = setup();
    await send('csat_closed', 'en', { surveyId: CSAT_SURVEY, messageId: '77' });

    expect(calls[1]).toEqual({ method: 'editMessageReplyMarkup', args: [CHAT, '77', undefined] });
    expect(calls[2]?.args).toEqual([CHAT, 'This survey has closed.']);
  });
});

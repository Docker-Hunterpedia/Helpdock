import type { DbTransaction, EmailDelivery, TelegramChat } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  CSAT_BRAND,
  CSAT_NOW,
  CSAT_SURVEY,
  CSAT_TICKET,
  csatSurveyRow,
} from '../testing/csat-doubles.js';
import { recordingTx } from '../testing/email-doubles.js';
import type { WidgetEmitInput } from '../widget/widget-relay.js';
import { CsatDelivery } from './csat-delivery.js';

const CONTACT = '0199f4b2-5555-7000-8000-0000000000ee';
const BOT = '0199f4b2-6666-7000-8000-0000000000ff';

const setup = ({
  chat,
  emailQueued = true,
}: {
  chat?: Partial<TelegramChat>;
  emailQueued?: boolean;
} = {}) => {
  const recording = recordingTx();
  const sent: string[] = [];
  const emails: unknown[] = [];
  const frames: WidgetEmitInput<'csat'>[] = [];
  const delivery = new CsatDelivery({
    repository: {
      markSent: (_tx, surveyId) => {
        sent.push(surveyId);
        return Promise.resolve();
      },
    },
    email: {
      queueCsatSurvey: (_tx, input) => {
        emails.push(input);
        return Promise.resolve(emailQueued ? ({ id: 'delivery' } as EmailDelivery) : undefined);
      },
    },
    telegram: {
      chatForTicket: () =>
        Promise.resolve(chat === undefined ? undefined : ({ botId: BOT, ...chat } as TelegramChat)),
    },
    locales: { localeForContact: () => Promise.resolve('ar') },
    widget: {
      emit: (input) => {
        frames.push(input as WidgetEmitInput<'csat'>);
        return Promise.resolve();
      },
    },
  });
  const deliver = (channel: 'chat' | 'telegram' | 'email' | 'form') =>
    delivery.deliver(
      recording.tx as DbTransaction,
      CSAT_BRAND,
      { id: CSAT_TICKET, channel, contactId: CONTACT, departmentId: 'd' },
      csatSurveyRow(),
      CSAT_NOW,
    );

  return { deliver, sent, emails, frames, outbox: recording.outbox };
};

describe('CsatDelivery', () => {
  it('offers the widget card at once, to the conversation’s room, and counts it sent', async () => {
    const { deliver, sent, frames } = setup();

    expect(await deliver('chat')).toBe('widget');
    expect(sent).toEqual([CSAT_SURVEY]);
    expect(frames).toEqual([
      {
        room: `conversation:${CSAT_TICKET}`,
        event: 'csat',
        data: {
          conversationId: CSAT_TICKET,
          state: 'open',
          rating: null,
          comment: null,
          skippedAt: null,
        },
        seq: null,
      },
    ]);
  });

  it('asks for the Telegram survey through the outbox, in the contact’s language', async () => {
    const { deliver, sent, outbox } = setup({ chat: { chatId: '4242' } });

    expect(await deliver('telegram')).toBe('telegram');
    expect(outbox).toEqual([
      {
        event: 'telegram.notice',
        payload: {
          botId: BOT,
          chatId: '4242',
          notice: 'csat_survey',
          locale: 'ar',
          csat: { surveyId: CSAT_SURVEY },
        },
      },
    ]);
    // Sent once Telegram accepts the message, not before.
    expect(sent).toEqual([]);
  });

  it('leaves a Telegram ticket with no chat unreached', async () => {
    const { deliver, outbox } = setup();

    expect(await deliver('telegram')).toBe('unreachable');
    expect(outbox).toEqual([]);
  });

  it.each(['email', 'form'] as const)('emails the survey for a %s ticket', async (channel) => {
    const { deliver, emails } = setup();

    expect(await deliver(channel)).toBe('email');
    expect(emails).toEqual([{ brandId: CSAT_BRAND, ticketId: CSAT_TICKET, surveyId: CSAT_SURVEY }]);
  });

  it('says so when there is nobody to email', async () => {
    const { deliver } = setup({ emailQueued: false });

    expect(await deliver('email')).toBe('unreachable');
  });
});

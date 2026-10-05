import type { CsatResponse } from '@helpdock/db';
import type { WidgetCsat } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { CsatRepository } from '../csat/csat.repository.js';
import {
  CSAT_BRAND,
  CSAT_NOW,
  CSAT_SURVEY,
  CSAT_TICKET,
  csatSurveyRow,
} from '../testing/csat-doubles.js';
import { recordingTx } from '../testing/email-doubles.js';
import type { WidgetConversationsService } from './widget-conversations.service.js';
import { WidgetCsatService, widgetCsatOf } from './widget-csat.service.js';
import type { VisitorScope, WidgetGate } from './widget-gate.js';
import type { WidgetEmitInput } from './widget-relay.js';

const LATER = new Date(CSAT_NOW.getTime() + 60_000);
const FACTS = { origin: 'https://shop.example.com', authorization: 'Visitor x', ip: null };

describe('widgetCsatOf', () => {
  const stateOf = (overrides: Partial<CsatResponse>, now = LATER) =>
    widgetCsatOf(CSAT_TICKET, csatSurveyRow(overrides), now).state;

  it('is open until something happens to it', () => {
    expect(stateOf({})).toBe('open');
  });

  it('puts an answer first, then the thirty days, then Skip', () => {
    const expired = new Date(CSAT_NOW.getTime() + 31 * 86_400_000);

    expect(stateOf({ ratedAt: LATER, rating: 4, skippedAt: LATER }, expired)).toBe('rated');
    expect(stateOf({ skippedAt: LATER }, expired)).toBe('expired');
    expect(stateOf({ skippedAt: LATER })).toBe('skipped');
  });

  it('carries the answer and when Skip was pressed', () => {
    expect(
      widgetCsatOf(CSAT_TICKET, csatSurveyRow({ skippedAt: LATER }), LATER),
    ).toEqual<WidgetCsat>({
      conversationId: CSAT_TICKET,
      state: 'skipped',
      rating: null,
      comment: null,
      skippedAt: LATER.toISOString(),
    });
  });
});

describe('WidgetCsatService', () => {
  const setup = ({
    channel = 'chat',
    closedAt = CSAT_NOW as Date | null,
    survey = csatSurveyRow() as CsatResponse | null,
  } = {}) => {
    const recording = recordingTx();
    const frames: WidgetEmitInput<'csat'>[] = [];
    const gate = {
      visitor: (
        _brand: string,
        _facts: unknown,
        _options: unknown,
        fn: (s: VisitorScope) => unknown,
      ) => fn({ tx: recording.tx } as VisitorScope),
    } as unknown as WidgetGate;
    const conversations = {
      require: () => Promise.resolve({ ticket: { id: CSAT_TICKET, channel, closedAt } }),
    } as unknown as Pick<WidgetConversationsService, 'require'>;
    const repository: Pick<CsatRepository, 'latestForTicket' | 'rate' | 'skip'> = {
      latestForTicket: () => Promise.resolve(survey ?? undefined),
      rate: (_tx, _id, answer) =>
        Promise.resolve(
          csatSurveyRow({ rating: answer.rating, comment: answer.comment, ratedAt: answer.at }),
        ),
      skip: () => Promise.resolve(true),
    };
    const service = new WidgetCsatService({
      gate,
      conversations,
      repository,
      broadcast: {
        emit: (input) => {
          frames.push(input as WidgetEmitInput<'csat'>);
          return Promise.resolve();
        },
      },
      now: () => LATER,
    });

    return { service, frames, outbox: recording.outbox };
  };

  it('shows the card of the conversation’s current close', async () => {
    const { service } = setup();

    expect((await service.card(CSAT_BRAND, FACTS, CSAT_TICKET)).csat?.state).toBe('open');
  });

  it.each([
    ['an email ticket a verified visitor can read', { channel: 'email' }],
    ['a reopened conversation', { closedAt: null }],
    ['a close with no survey yet', { survey: null }],
    ['an earlier close’s survey', { closedAt: LATER }],
  ])('shows no card for %s', async (_label, options) => {
    const { service } = setup(options as Parameters<typeof setup>[0]);

    expect(await service.card(CSAT_BRAND, FACTS, CSAT_TICKET)).toEqual({ csat: null });
  });

  it('records a rating as a widget answer and tells every device in the room', async () => {
    const { service, frames, outbox } = setup();
    const { csat } = await service.rate(CSAT_BRAND, FACTS, CSAT_TICKET, {
      rating: 4,
      comment: 'Quick',
    });

    expect(csat).toMatchObject({ state: 'rated', rating: 4, comment: 'Quick' });
    expect(outbox[0]).toMatchObject({
      event: 'csat.received',
      payload: { surveyId: CSAT_SURVEY, via: 'widget' },
    });
    expect(frames).toEqual([
      { room: `conversation:${CSAT_TICKET}`, event: 'csat', data: csat, seq: null },
    ]);
  });

  it('skips without recording an answer', async () => {
    const { service, outbox, frames } = setup();
    const { csat } = await service.skip(CSAT_BRAND, FACTS, CSAT_TICKET);

    expect(csat).toMatchObject({ state: 'skipped', skippedAt: LATER.toISOString() });
    expect(outbox).toEqual([]);
    expect(frames).toHaveLength(1);
  });

  it('tells nobody when there is no card to change', async () => {
    const { service, frames } = setup({ survey: null });

    expect(await service.skip(CSAT_BRAND, FACTS, CSAT_TICKET)).toEqual({ csat: null });
    expect(frames).toEqual([]);
  });
});

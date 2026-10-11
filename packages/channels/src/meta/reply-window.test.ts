import {
  META_HUMAN_AGENT_WINDOW_MS,
  META_REPLY_WINDOW_MS,
  replyWindowSchema,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { type ReplyWindowInput, replyWindow, replyWindowView } from './reply-window.js';

const ANCHOR = new Date('2026-10-11T08:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const at = (offsetMs: number): Date => new Date(ANCHOR.getTime() + offsetMs);

const ask = (override: Partial<ReplyWindowInput> & { readonly now: Date }) =>
  replyWindow({
    platform: 'messenger',
    lastInboundAt: ANCHOR,
    humanAgentEnabled: false,
    personAuthored: true,
    ...override,
  });

describe('the 24-hour window, on every platform', () => {
  it.each(['whatsapp', 'messenger', 'instagram'] as const)(
    'is open at 23 h 59 m and closed at 24 h 01 m on %s',
    (platform) => {
      expect(ask({ platform, now: at(DAY - MINUTE) })).toEqual({
        state: 'open',
        closesAt: at(DAY),
      });
      expect(ask({ platform, now: at(DAY + MINUTE) })).toEqual({
        state: 'closed',
        closedAt: at(DAY),
      });
    },
  );

  it('is open up to the last millisecond and closed from the instant the day is up', () => {
    expect(ask({ now: at(DAY - 1) }).state).toBe('open');
    expect(ask({ now: at(DAY) })).toEqual({ state: 'closed', closedAt: at(DAY) });
  });

  it('is open at the moment the customer wrote, and a clock that is behind does not close it', () => {
    expect(ask({ now: ANCHOR })).toEqual({ state: 'open', closesAt: at(DAY) });
    expect(ask({ now: at(-5 * MINUTE) })).toEqual({ state: 'open', closesAt: at(DAY) });
  });

  it('says when it closes, so the strip can count down', () => {
    const window = ask({ now: at(3 * HOUR) });

    expect(window).toEqual({ state: 'open', closesAt: at(META_REPLY_WINDOW_MS) });
  });

  it('is closed with no date when the customer never wrote', () => {
    for (const platform of ['whatsapp', 'messenger', 'instagram'] as const) {
      expect(ask({ platform, lastInboundAt: null, now: at(0) })).toEqual({
        state: 'closed',
        closedAt: null,
      });
    }
  });

  it('is closed with no date even for a person with the extension on', () => {
    expect(
      ask({ lastInboundAt: null, humanAgentEnabled: true, personAuthored: true, now: at(0) }),
    ).toEqual({ state: 'closed', closedAt: null });
  });
});

describe('the seven days of the Human Agent feature', () => {
  const extended = { humanAgentEnabled: true, personAuthored: true } as const;

  it.each(['messenger', 'instagram'] as const)(
    'lets a person write on %s between 24 hours and 7 days when the switch is on',
    (platform) => {
      expect(ask({ platform, ...extended, now: at(DAY + MINUTE) })).toEqual({
        state: 'human_agent',
        closesAt: at(META_HUMAN_AGENT_WINDOW_MS),
      });
      expect(ask({ platform, ...extended, now: at(3 * DAY) }).state).toBe('human_agent');
    },
  );

  it('keeps the plain window open inside the first day, whatever the switch says', () => {
    expect(ask({ ...extended, now: at(DAY - MINUTE) })).toEqual({
      state: 'open',
      closesAt: at(DAY),
    });
  });

  it('closes at 7 days on the minute, and reports 7 days as when it closed', () => {
    expect(ask({ ...extended, now: at(7 * DAY - MINUTE) }).state).toBe('human_agent');
    expect(ask({ ...extended, now: at(7 * DAY) })).toEqual({
      state: 'closed',
      closedAt: at(7 * DAY),
    });
    expect(ask({ ...extended, now: at(7 * DAY + MINUTE) })).toEqual({
      state: 'closed',
      closedAt: at(7 * DAY),
    });
  });

  it('never gives WhatsApp the extension: its window is 24 hours, switch or not', () => {
    expect(ask({ platform: 'whatsapp', ...extended, now: at(DAY + MINUTE) })).toEqual({
      state: 'closed',
      closedAt: at(DAY),
    });
  });

  it('gives an AI reply, a rule, an auto-responder or a survey the 24 hours only', () => {
    expect(ask({ humanAgentEnabled: true, personAuthored: false, now: at(DAY + MINUTE) })).toEqual({
      state: 'closed',
      closedAt: at(DAY),
    });
  });

  it('gives nothing past 24 hours while the account’s switch is off', () => {
    expect(ask({ humanAgentEnabled: false, personAuthored: true, now: at(2 * DAY) })).toEqual({
      state: 'closed',
      closedAt: at(DAY),
    });
  });
});

describe('replyWindowView', () => {
  it('writes each state as the wire shape the ticket route sends', () => {
    const views = [
      replyWindowView(ask({ now: at(HOUR) })),
      replyWindowView(ask({ humanAgentEnabled: true, personAuthored: true, now: at(2 * DAY) })),
      replyWindowView(ask({ now: at(2 * DAY) })),
      replyWindowView(ask({ lastInboundAt: null, now: at(0) })),
    ];

    expect(views).toEqual([
      { state: 'open', closesAt: '2026-10-12T08:00:00.000Z' },
      { state: 'human_agent', closesAt: '2026-10-18T08:00:00.000Z' },
      { state: 'closed', closedAt: '2026-10-12T08:00:00.000Z' },
      { state: 'closed', closedAt: null },
    ]);
    for (const view of views) {
      expect(replyWindowSchema.safeParse(view).success).toBe(true);
    }
  });
});

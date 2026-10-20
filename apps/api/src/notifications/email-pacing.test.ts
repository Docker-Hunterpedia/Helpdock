import { describe, expect, it } from 'vitest';
import {
  afterArrival,
  afterSend,
  capped,
  INITIAL_PACING,
  isUrgent,
  type PacingConfig,
  type PacingState,
  pacingConfigFromMinutes,
  plannedSendAt,
  presenceDecision,
  urgentSendAt,
} from './email-pacing.js';

const MINUTE = 60_000;
const START = new Date('2026-10-20T09:00:00.000Z');
const at = (minutes: number): Date => new Date(START.getTime() + minutes * MINUTE);
const minutesOf = (date: Date | null): number | null =>
  date === null ? null : (date.getTime() - START.getTime()) / MINUTE;

/** The plan's defaults (DOMAIN-RULES §20). */
const config: PacingConfig = pacingConfigFromMinutes({
  firstWaitMinutes: 2,
  backoffMinutes: [10, 20, 40, 60],
  quietResetMinutes: 120,
  urgentIntervalMinutes: 5,
  urgentPerDay: 8,
  perHour: 6,
  perDay: 40,
});

/**
 * Plays a person's day on a fake clock: each arrival opens a batch when none
 * is pending, and the batch sends at its planned time. Returns the minutes
 * each email went at.
 */
const simulate = (arrivals: readonly number[], until: number): number[] => {
  let state: PacingState = INITIAL_PACING;
  let pendingAt: Date | null = null;
  const sends: number[] = [];
  const queue = [...arrivals].sort((a, b) => a - b);

  for (let minute = 0; minute <= until; minute += 1) {
    const now = at(minute);
    if (pendingAt !== null && now >= pendingAt) {
      state = afterSend(config, state, now, 'paced');
      sends.push(minute);
      pendingAt = null;
    }
    while (queue[0] === minute) {
      queue.shift();
      state = afterArrival(config, state, now);
      pendingAt ??= plannedSendAt(config, state, now);
    }
  }

  return sends;
};

describe('Right away pacing (M14-10)', () => {
  it('sends the first email after the first wait, gathering what arrives meanwhile', () => {
    expect(simulate([0, 1], 30)).toEqual([2]);
  });

  it('backs off 10, 20, 40, 60 minutes while more keeps arriving, and stays at 60', () => {
    const everyFiveMinutes = Array.from({ length: 72 }, (_, index) => index * 5);

    expect(simulate(everyFiveMinutes, 360)).toEqual([2, 12, 32, 72, 132, 192, 252, 312]);
  });

  it('sends no more than six emails for twelve notifications in an hour (exit criterion)', () => {
    const sends = simulate(
      Array.from({ length: 12 }, (_, index) => index * 5),
      60,
    );

    expect(sends.length).toBeLessThanOrEqual(6);
  });

  it('goes back to the first wait after two quiet hours', () => {
    let state = afterArrival(config, INITIAL_PACING, at(0));
    state = afterSend(config, state, at(2), 'paced');
    state = afterArrival(config, state, at(5));
    state = afterSend(config, state, at(12), 'paced');
    expect(state.step).toBe(2);

    const quiet = afterArrival(config, state, at(12 + 120));
    expect(quiet.step).toBe(0);
    expect(minutesOf(plannedSendAt(config, quiet, at(132)))).toBe(134);

    const notQuiet = afterArrival(config, state, at(12 + 119));
    expect(notQuiet.step).toBe(2);
  });

  it('waits at least the first wait even when the back-off has already passed', () => {
    let state = afterArrival(config, INITIAL_PACING, at(0));
    state = afterSend(config, state, at(2), 'paced');
    state = afterArrival(config, state, at(50));

    expect(minutesOf(plannedSendAt(config, state, at(50)))).toBe(52);
  });
});

describe('urgent kinds', () => {
  it('are mentions, SLA breaches and escalations', () => {
    expect(
      ['mentioned', 'sla_breached', 'escalated'].every((kind) => isUrgent(kind as never)),
    ).toBe(true);
    expect(isUrgent('assigned')).toBe(false);
    expect(isUrgent('replied')).toBe(false);
    expect(isUrgent('sla_warning')).toBe(false);
  });

  it('cut the wait at once, then no more often than every five minutes', () => {
    let state = afterArrival(config, INITIAL_PACING, at(0));
    expect(minutesOf(urgentSendAt(config, state, at(0)))).toBe(0);

    state = afterSend(config, state, at(0), 'urgent');
    expect(minutesOf(urgentSendAt(config, state, at(1)))).toBe(5);
    expect(minutesOf(urgentSendAt(config, state, at(7)))).toBe(7);
  });

  it('cut at most eight times a day, then wait like anything else', () => {
    let state: PacingState = INITIAL_PACING;
    for (let index = 0; index < 8; index += 1) {
      state = afterSend(config, state, at(index * 10), 'urgent');
    }

    expect(state.urgentSentInDay).toBe(8);
    expect(urgentSendAt(config, state, at(100))).toBeNull();
    // A new day window gives the allowance back.
    expect(minutesOf(urgentSendAt(config, state, at(24 * 60)))).toBe(24 * 60);
  });

  it('still respect the hour cap', () => {
    let state: PacingState = INITIAL_PACING;
    for (let index = 0; index < 6; index += 1) {
      state = afterSend(config, state, at(index * 5), 'urgent');
    }

    expect(minutesOf(urgentSendAt(config, state, at(30)))).toBe(60);
  });
});

describe('caps', () => {
  it('allow six emails an hour, counted from the first, digests included', () => {
    let state: PacingState = INITIAL_PACING;
    for (let index = 0; index < 5; index += 1) {
      state = afterSend(config, state, at(index), 'paced');
    }
    state = afterSend(config, state, at(5), 'digest');

    expect(state.sentInHour).toBe(6);
    expect(minutesOf(capped(config, state, at(10)))).toBe(60);
    expect(minutesOf(capped(config, state, at(61)))).toBe(61);
  });

  it('allow forty a day, and move past the hour window when the day is spent', () => {
    let state: PacingState = INITIAL_PACING;
    for (let sent = 0; sent < 40; sent += 1) {
      state = afterSend(config, state, at(Math.floor(sent / 6) * 60 + (sent % 6)), 'digest');
    }

    expect(state.sentInDay).toBe(40);
    expect(state.sentInHour).toBe(4);
    expect(minutesOf(capped(config, state, at(7 * 60)))).toBe(24 * 60);
  });

  it('open a new window once the old one has run out', () => {
    let state = afterSend(config, INITIAL_PACING, at(0), 'paced');
    state = afterSend(config, state, at(61), 'paced');

    expect(minutesOf(state.hourWindowStart)).toBe(61);
    expect(state.sentInHour).toBe(1);
    expect(state.sentInDay).toBe(2);
  });

  it('leave the back-off alone for a digest', () => {
    const state = afterSend(config, INITIAL_PACING, at(0), 'digest');

    expect(state.step).toBe(0);
    expect(state.nextAllowedAt).toBeNull();
    expect(state.sentInHour).toBe(1);
  });
});

describe('the presence hold (D-27)', () => {
  const none = { heldSince: null, seenOnlineAt: null };

  it('sends at once to someone away or offline who was never found online', () => {
    expect(presenceDecision('away', none, at(0))).toEqual({ kind: 'send' });
    expect(presenceDecision('offline', none, at(0))).toEqual({ kind: 'send' });
  });

  it('holds while they are online, looking again every minute', () => {
    expect(presenceDecision('online', none, at(0))).toEqual({
      kind: 'hold',
      until: at(1),
      hold: { heldSince: at(0), seenOnlineAt: at(0) },
    });
  });

  it('sends once they have been away for five minutes', () => {
    const hold = { heldSince: at(0), seenOnlineAt: at(3) };

    expect(presenceDecision('away', hold, at(5))).toEqual({ kind: 'hold', until: at(8), hold });
    expect(presenceDecision('offline', hold, at(8))).toEqual({ kind: 'send' });
  });

  it('sends after fifteen minutes however long they stay online', () => {
    expect(
      presenceDecision('online', { heldSince: at(0), seenOnlineAt: at(14) }, at(14.5)),
    ).toEqual({ kind: 'hold', until: at(15), hold: { heldSince: at(0), seenOnlineAt: at(14.5) } });
    expect(presenceDecision('online', { heldSince: at(0), seenOnlineAt: at(14) }, at(15))).toEqual({
      kind: 'send',
    });
  });

  it('never waits for the away grace past the fifteen-minute cap', () => {
    const hold = { heldSince: at(0), seenOnlineAt: at(14) };

    expect(presenceDecision('away', hold, at(14.5))).toEqual({ kind: 'hold', until: at(15), hold });
  });
});

describe('pacingConfigFromMinutes', () => {
  it('turns the install settings into milliseconds and keeps the counts', () => {
    expect(config).toEqual({
      firstWaitMs: 2 * MINUTE,
      backoffMs: [10 * MINUTE, 20 * MINUTE, 40 * MINUTE, 60 * MINUTE],
      quietResetMs: 120 * MINUTE,
      urgentIntervalMs: 5 * MINUTE,
      urgentPerDay: 8,
      perHour: 6,
      perDay: 40,
    });
  });
});

import { alwaysOpenCalendar, type BusinessCalendar } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  breach,
  type Clock,
  elapsedAt,
  hasFired,
  markFired,
  pause,
  remainingAt,
  restart,
  resume,
  retarget,
  satisfy,
  startClock,
  stop,
  timeOfPercent,
} from './clock.js';

const utc = alwaysOpenCalendar('UTC');
const closed: BusinessCalendar = {
  timezone: 'UTC',
  weekly: [[], [], [], [], [], [], []],
  holidays: [],
};
const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 1, 9, minutes));
const MINUTE = 60_000;

const fresh = (): Clock =>
  startClock(
    { kind: 'resolution', cycle: 0, policyId: 'p', targetMinutes: 60, timeMode: 'calendar' },
    utc,
    at(0),
  );

describe('a clock', () => {
  it('is due one target after it starts under calendar hours', () => {
    expect(fresh().dueAt).toEqual(at(60));
    expect(remainingAt(fresh(), utc, at(15))).toBe(45 * MINUTE);
  });

  it('has no due time under a calendar that never opens', () => {
    const never = startClock(
      { kind: 'resolution', cycle: 0, policyId: 'p', targetMinutes: 60, timeMode: 'business' },
      closed,
      at(0),
    );
    expect(never.dueAt).toBeNull();
  });

  it('stops counting while paused and resumes with what was left', () => {
    const paused = pause(fresh(), utc, at(20));
    expect(elapsedAt(paused, utc, at(50))).toBe(20 * MINUTE);
    expect(pause(paused, utc, at(30))).toBe(paused);

    const resumed = resume(paused, utc, at(40));
    expect(resumed.dueAt).toEqual(at(80));
    expect(resumed.pausedTotalMs).toBe(20 * MINUTE);
    expect(resume(resumed, utc, at(45))).toBe(resumed);
  });

  it('keeps a due time it has already passed rather than inventing one', () => {
    const late = retarget(
      fresh(),
      { before: utc, after: utc },
      { policyId: 'p', targetMinutes: 10, timeMode: 'calendar' },
      at(30),
    );
    expect(late.breachedAt).toEqual(at(30));
    expect(late.dueAt).toEqual(at(30));
    expect(timeOfPercent(late, utc, 50)).toEqual(at(30));
  });

  it('records a breach once, at the due time it missed', () => {
    const breached = breach(fresh(), at(70));
    expect(breached.breachedAt).toEqual(at(60));
    expect(breach(breached, at(90))).toBe(breached);
    expect(breach(fresh(), at(30)).breachedAt).toEqual(at(30));
  });

  it('marks a step once', () => {
    const fired = markFired(fresh(), 75, at(45));
    expect(hasFired(fired, 75)).toBe(true);
    expect(markFired(fired, 75, at(50))).toBe(fired);
  });

  it('ends on satisfy or stop, folding an open pause into the paused total', () => {
    const paused = pause(fresh(), utc, at(10));
    const met = satisfy(paused, utc, at(30));
    expect(met).toMatchObject({ satisfiedAt: at(30), pausedAt: null, dueAt: null });
    expect(met.pausedTotalMs).toBe(20 * MINUTE);
    expect(satisfy(met, utc, at(40))).toBe(met);

    const stopped = stop(fresh(), utc, at(10), 'merged');
    expect(stopped).toMatchObject({ stoppedAt: at(10), stopReason: 'merged', dueAt: null });
    expect(stop(stopped, utc, at(20), 'closed')).toBe(stopped);
    expect(
      retarget(
        stopped,
        { before: utc, after: utc },
        { policyId: 'q', targetMinutes: 5, timeMode: 'calendar' },
        at(20),
      ),
    ).toBe(stopped);
  });

  it('restarts after a stop without counting the time between', () => {
    const stopped = stop(fresh(), utc, at(10), 'merged');
    const restarted = restart(stopped, utc, at(40));

    expect(restarted.dueAt).toEqual(at(90));
    expect(restarted.pausedTotalMs).toBe(30 * MINUTE);
    expect(restart(restarted, utc, at(50))).toBe(restarted);
  });

  it('has no step times while it is not counting', () => {
    expect(timeOfPercent(pause(fresh(), utc, at(5)), utc, 50)).toBeNull();
  });
});

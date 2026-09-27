import { alwaysOpenCalendar } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { breach, type Clock, markFired, pause, satisfy, startClock, stop } from './clock.js';
import { summaryOf, ticketSlaView, ticketState } from './sla-view.js';

const utc = alwaysOpenCalendar('UTC');
const calendarFor = () => utc;
const DEPARTMENT = '01937f5e-7e53-7000-8000-0000000000d1';
const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 1, 9, minutes));

const clock = (kind: Clock['kind'], targetMinutes: number, cycle = 0): Clock =>
  startClock({ kind, cycle, policyId: 'p', targetMinutes, timeMode: 'calendar' }, utc, at(0));

const response = clock('first_response', 100);
const resolution = clock('resolution', 400);
const policy = {
  id: '01937f5e-7e53-7000-8000-0000000000a1',
  name: 'Billing and Returns',
  timeMode: 'business' as const,
  escalation: [
    {
      atPercent: 75,
      actions: [{ type: 'notify' as const, recipient: { kind: 'department_leads' as const } }],
    },
  ],
};

describe('ticketState', () => {
  it('is running while every clock has room', () => {
    expect(ticketState([response, resolution], calendarFor, DEPARTMENT, at(10))).toBe('running');
  });

  it('warns under a fifth left, or once a step fired', () => {
    expect(ticketState([response, resolution], calendarFor, DEPARTMENT, at(85))).toBe('warning');
    expect(ticketState([markFired(response, 50, at(50))], calendarFor, DEPARTMENT, at(51))).toBe(
      'warning',
    );
  });

  it('is breached past the due time, recorded or not', () => {
    expect(ticketState([response], calendarFor, DEPARTMENT, at(101))).toBe('breached');
    expect(ticketState([breach(response, at(100))], calendarFor, DEPARTMENT, at(101))).toBe(
      'breached',
    );
  });

  it('is paused, met, or nothing once the clocks have ended without a verdict', () => {
    expect(ticketState([pause(resolution, utc, at(5))], calendarFor, DEPARTMENT, at(10))).toBe(
      'paused',
    );
    expect(
      ticketState(
        [satisfy(response, utc, at(5)), satisfy(resolution, utc, at(6))],
        calendarFor,
        DEPARTMENT,
        at(10),
      ),
    ).toBe('met');
    expect(
      ticketState([stop(resolution, utc, at(5), 'no_policy')], calendarFor, DEPARTMENT, at(10)),
    ).toBe('none');
  });
});

describe('summaryOf', () => {
  it('follows the running clock due first', () => {
    expect(summaryOf([resolution, response], calendarFor, DEPARTMENT, at(20))).toEqual({
      state: 'running',
      clock: 'first_response',
      remainingMs: 80 * 60_000,
      breachedAt: null,
      reopened: false,
    });
  });

  it('names a breach and a reopen', () => {
    const next = breach(clock('next_response', 100, 1), at(100));
    expect(summaryOf([next], calendarFor, DEPARTMENT, at(110))).toMatchObject({
      state: 'breached',
      breachedAt: at(100).toISOString(),
      reopened: true,
    });
  });

  it('is null when no policy applies', () => {
    expect(summaryOf([], calendarFor, DEPARTMENT, at(0))).toBeNull();
  });
});

describe('ticketSlaView', () => {
  it('draws the card with the step that ran last and what it did', () => {
    const fired = markFired(resolution, 75, at(300));
    const view = ticketSlaView({
      clocks: [fired, satisfy(response, utc, at(30))],
      calendarFor,
      departmentId: DEPARTMENT,
      at: at(310),
      policy,
      initialResponse: undefined,
    });

    expect(view).toMatchObject({
      state: 'warning',
      policyName: 'Billing and Returns',
      lastStep: { clock: 'resolution', percent: 75, actions: policy.escalation[0]?.actions },
      reopenedAt: null,
      initialResponse: null,
    });
    expect(view.clocks.map((entry) => entry.kind)).toEqual(['first_response', 'resolution']);
  });

  it('says how the initial response ended after a reopen', () => {
    const view = ticketSlaView({
      clocks: [clock('next_response', 100, 1), clock('resolution', 400, 1)],
      calendarFor,
      departmentId: DEPARTMENT,
      at: at(10),
      policy,
      initialResponse: { satisfiedAt: at(0), breachedAt: null },
    });

    expect(view).toMatchObject({ initialResponse: 'met', reopenedAt: at(0).toISOString() });
    expect(
      ticketSlaView({
        clocks: [clock('next_response', 100, 1)],
        calendarFor,
        departmentId: DEPARTMENT,
        at: at(10),
        policy,
        initialResponse: { satisfiedAt: at(0), breachedAt: at(0) },
      }).initialResponse,
    ).toBe('breached');
  });

  it('is empty when no policy applies', () => {
    expect(
      ticketSlaView({
        clocks: [],
        calendarFor,
        departmentId: DEPARTMENT,
        at: at(0),
        policy: null,
        initialResponse: undefined,
      }),
    ).toMatchObject({ state: 'none', clocks: [], policyId: null, lastStep: null });
  });
});

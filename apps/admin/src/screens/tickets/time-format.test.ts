import { MAX_TIME_ENTRY_SECONDS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { clockOf, durationOf, loggableSeconds, secondsFrom } from './time-format.js';

describe('durationOf', () => {
  it.each([
    [30, '30s'],
    [45 * 60, '45m'],
    [3600, '1h'],
    [85 * 60, '1h 25m'],
    // Minutes round down: a timer at 1h 59m 50s has not reached two hours.
    [2 * 3600 - 10, '1h 59m'],
  ])('prints %i seconds as %s', (seconds, printed) => {
    expect(durationOf(seconds)).toBe(printed);
  });
});

describe('clockOf', () => {
  it('prints the running timer as the artboard does', () => {
    expect(clockOf(12 * 60 + 40)).toBe('00:12:40');
    expect(clockOf(25 * 3600 + 1)).toBe('25:00:01');
  });
});

describe('secondsFrom', () => {
  it('turns the dialog’s fields into seconds', () => {
    expect(secondsFrom(0, 30)).toBe(1800);
    expect(secondsFrom(24, 59)).toBe(MAX_TIME_ENTRY_SECONDS);
  });

  it.each([
    ['nothing at all', 0, 0],
    ['a minute past 59', 0, 60],
    ['more than a day', 25, 0],
    ['a negative hour', -1, 30],
    ['a fraction', 1.5, 0],
    ['an empty field', Number.NaN, 30],
  ])('refuses %s', (_label, hours, minutes) => {
    expect(secondsFrom(hours, minutes)).toBeNull();
  });
});

describe('loggableSeconds', () => {
  it('has nothing to log for a timer that never ran', () => {
    expect(loggableSeconds(0)).toBeNull();
  });

  it('caps a timer left running over a weekend at the longest entry', () => {
    expect(loggableSeconds(3 * 86_400)).toBe(MAX_TIME_ENTRY_SECONDS);
  });
});

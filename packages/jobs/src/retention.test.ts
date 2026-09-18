import { describe, expect, it } from 'vitest';
import { retentionCutoff } from './retention.js';

const now = new Date('2026-09-19T12:00:00.000Z');

describe('retentionCutoff', () => {
  it.each([
    { days: 7, cutoff: '2026-09-12T12:00:00.000Z' },
    { days: 90, cutoff: '2026-06-21T12:00:00.000Z' },
  ])('is $days days before now', ({ days, cutoff }) => {
    expect(retentionCutoff(days, now).toISOString()).toBe(cutoff);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses %s days', (days) => {
    expect(() => retentionCutoff(days, now)).toThrow(RangeError);
  });
});

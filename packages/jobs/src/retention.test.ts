import { describe, expect, it } from 'vitest';
import { drainInBatches, retentionCutoff } from './retention.js';

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

describe('drainInBatches', () => {
  it('keeps going while a batch comes back full, and stops on the first short one', async () => {
    const batches = [3, 3, 1, 3];
    const calls: number[] = [];

    const total = await drainInBatches(async () => {
      const removed = batches[calls.length] ?? 0;
      calls.push(removed);
      return removed;
    }, 3);

    expect(total).toBe(7);
    expect(calls).toEqual([3, 3, 1]);
  });

  it('runs once when there is nothing to purge', async () => {
    let calls = 0;

    expect(
      await drainInBatches(async () => {
        calls += 1;
        return 0;
      }),
    ).toBe(0);
    expect(calls).toBe(1);
  });
});

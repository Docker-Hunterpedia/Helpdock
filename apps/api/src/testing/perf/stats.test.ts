import { describe, expect, it } from 'vitest';
import { percentile, summarise } from './stats.js';

describe('percentile', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);

  it('answers a sample that was actually observed (nearest rank)', () => {
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([10, 20, 30], 95)).toBe(30);
  });

  it('answers NaN for no samples rather than a latency nobody measured', () => {
    expect(percentile([], 95)).toBeNaN();
  });

  it('refuses a percentile outside (0, 100]', () => {
    expect(() => percentile(hundred, 0)).toThrow(RangeError);
    expect(() => percentile(hundred, 101)).toThrow(RangeError);
  });
});

describe('summarise', () => {
  it('ranks by value, whatever order the samples arrived in', () => {
    expect(summarise([5, 1, 4, 2, 3])).toEqual({ count: 5, p50: 3, p95: 5, p99: 5, max: 5 });
  });
});

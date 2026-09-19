import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCompact,
  formatCount,
  formatDuration,
  formatMs,
  formatUsd,
  percentOf,
  secondsSince,
} from './format.js';

describe('formatCount', () => {
  it('groups thousands and keeps Latin numerals whatever the document language is', () => {
    document.documentElement.lang = 'ar';

    expect(formatCount(1204)).toBe('1,204');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatCompact', () => {
  it('shortens the way the artboard writes a token count', () => {
    expect(formatCompact(2_100_000)).toBe('2.1 M');
    expect(formatCompact(4200)).toBe('4.2 k');
    expect(formatCompact(812)).toBe('812');
  });
});

describe('formatBytes', () => {
  it('climbs to the unit that reads best', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(19_756_775_014)).toBe('18.4 GB');
  });

  it('drops the decimal once the number is wide enough without it', () => {
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });
});

describe('formatUsd', () => {
  it('is a currency, so the reader is not left guessing which one', () => {
    expect(formatUsd(6.4)).toBe('$6.40');
  });
});

describe('formatMs', () => {
  it('keeps one decimal only while the number is small enough to need it', () => {
    expect(formatMs(0.4)).toBe('0.4');
    expect(formatMs(84.3)).toBe('84');
  });
});

describe('formatDuration', () => {
  it('coarsens as the wait grows, because "is it stuck?" is the question', () => {
    expect(formatDuration(12)).toBe('12 s');
    expect(formatDuration(247)).toBe('4 m');
    expect(formatDuration(7400)).toBe('2 h');
    expect(formatDuration(200_000)).toBe('2 d');
  });

  it('never shows a negative age', () => {
    expect(formatDuration(-5)).toBe('0 s');
  });
});

describe('secondsSince', () => {
  it('counts whole seconds', () => {
    const now = Date.parse('2026-09-19T10:00:12.400Z');

    expect(secondsSince('2026-09-19T10:00:00.000Z', now)).toBe(12);
  });

  it('is zero for a timestamp slightly in the future, rather than a negative age', () => {
    const now = Date.parse('2026-09-19T10:00:00.000Z');

    expect(secondsSince('2026-09-19T10:00:05.000Z', now)).toBe(0);
  });
});

describe('percentOf', () => {
  it('rounds to a whole percent and clamps to the bar it draws', () => {
    expect(percentOf(6.4, 10)).toBe(64);
    expect(percentOf(20, 10)).toBe(100);
    expect(percentOf(-1, 10)).toBe(0);
  });

  it('is zero rather than infinite when there is no total', () => {
    expect(percentOf(5, 0)).toBe(0);
  });
});

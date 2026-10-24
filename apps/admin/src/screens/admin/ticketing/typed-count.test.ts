import { describe, expect, it } from 'vitest';
import { typedCountMatches } from './typed-count.js';

describe('typedCountMatches', () => {
  it('accepts Latin digits with or without separators', () => {
    expect(typedCountMatches('1284', 1284)).toBe(true);
    expect(typedCountMatches(' 1,284 ', 1284)).toBe(true);
  });

  it('accepts Arabic-Indic and Eastern Arabic digits', () => {
    expect(typedCountMatches('١٢٨٤', 1284)).toBe(true);
    expect(typedCountMatches('١٬٢٨٤', 1284)).toBe(true);
    expect(typedCountMatches('۱۲۸۴', 1284)).toBe(true);
  });

  it('refuses another number or nothing', () => {
    expect(typedCountMatches('١٢٨٣', 1284)).toBe(false);
    expect(typedCountMatches('', 0)).toBe(false);
  });
});

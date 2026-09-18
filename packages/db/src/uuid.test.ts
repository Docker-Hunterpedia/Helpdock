import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7, uuidv7Timestamp } from './uuid.js';

const VERSION_NIBBLE = 14;
const VARIANT_NIBBLE = 19;

describe('uuidv7', () => {
  it('carries version 7 and the RFC 9562 variant', () => {
    const id = uuidv7();

    expect(isUuid(id)).toBe(true);
    expect(id[VERSION_NIBBLE]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[VARIANT_NIBBLE]);
  });

  it('encodes the current time in the first 48 bits', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();

    expect(uuidv7Timestamp(id)).toBeGreaterThanOrEqual(before);
    expect(uuidv7Timestamp(id)).toBeLessThanOrEqual(after);
  });

  it('sorts as a string in the order it was generated, even within one millisecond', () => {
    const ids = Array.from({ length: 5_000 }, () => uuidv7());

    // A tight loop of 5,000 ids spans a handful of milliseconds at most, so this
    // is what proves the counter and not the clock is doing the ordering.
    expect(new Set(ids.map(uuidv7Timestamp)).size).toBeLessThan(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('never repeats an id', () => {
    const ids = Array.from({ length: 5_000 }, () => uuidv7());

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isUuid', () => {
  it.each([
    '00000000-0000-0000-0000-000000000000',
    '0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7b',
    '0199A2BC-1F00-7A3D-8B2E-1F6C9D2E4A7B',
  ])('accepts %s', (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    '',
    'not-a-uuid',
    "0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7b'; drop table users; --",
    '0199a2bc1f007a3d8b2e1f6c9d2e4a7b',
    '0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7',
    '0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7bb',
    '0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7g',
  ])('rejects %s', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { sourceAccountKey } from './source-account.js';

describe('source account identity', () => {
  it('keeps a verified account stable across runs while separating vendors and accounts', () => {
    const key = sourceAccountKey({ source: 'zendesk', verifiedAccount: 'one' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceAccountKey({ source: 'zendesk', verifiedAccount: 'one' })).toBe(key);
    expect(sourceAccountKey({ source: 'zendesk', verifiedAccount: 'two' })).not.toBe(key);
    expect(sourceAccountKey({ source: 'freshdesk', verifiedAccount: 'one' })).not.toBe(key);
  });
  it('refuses noncanonical, empty or oversized identifiers and credential fields', () => {
    for (const verifiedAccount of ['', ' one', 'one ', 'a'.repeat(201)]) {
      expect(() => sourceAccountKey({ source: 'zendesk', verifiedAccount })).toThrow();
    }
    expect(() =>
      sourceAccountKey({
        source: 'zendesk',
        verifiedAccount: 'one',
        credentials: 'secret',
      } as never),
    ).toThrow();
  });
});

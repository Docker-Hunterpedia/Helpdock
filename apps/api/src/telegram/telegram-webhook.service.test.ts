import { describe, expect, it } from 'vitest';
import { sameSecret } from './telegram-webhook.service.js';

describe('sameSecret', () => {
  it('accepts the secret that was registered', () => {
    expect(sameSecret('abc_DEF-123', 'abc_DEF-123')).toBe(true);
  });

  it('refuses anything else, whatever its length', () => {
    expect(sameSecret('abc_DEF-123', 'abc_DEF-124')).toBe(false);
    expect(sameSecret('abc_DEF-123', 'abc')).toBe(false);
    expect(sameSecret('abc_DEF-123', `abc_DEF-123${'x'.repeat(500)}`)).toBe(false);
  });
});

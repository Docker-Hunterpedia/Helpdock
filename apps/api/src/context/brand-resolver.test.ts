import { describe, expect, it } from 'vitest';
import { NoopBrandResolver } from './brand-resolver.js';

describe('NoopBrandResolver', () => {
  it('resolves no host to a brand until M5 adds brand domains', async () => {
    await expect(new NoopBrandResolver().resolve()).resolves.toBeNull();
  });
});

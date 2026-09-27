import { describe, expect, it } from 'vitest';
import { cleanComment, viewDay, visitorHash } from './visitor-key.js';

const brandA = '0192c3f0-0000-7000-8000-00000000000a';
const brandB = '0192c3f0-0000-7000-8000-00000000000b';

describe('the view and vote dedupe keys', () => {
  it('hashes the same visitor to the same key, and never stores the key itself', () => {
    const key = visitorHash(brandA, 'widget:visitor-1');

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(visitorHash(brandA, 'widget:visitor-1')).toBe(key);
    expect(key).not.toContain('visitor-1');
  });

  it('keys one visitor differently in two brands, so the rows cannot be matched across them', () => {
    expect(visitorHash(brandA, 'cookie-1')).not.toBe(visitorHash(brandB, 'cookie-1'));
    expect(visitorHash(brandA, 'cookie-1')).not.toBe(visitorHash(brandA, 'cookie-2'));
  });

  it('counts a day in UTC, whatever the clock’s zone', () => {
    expect(viewDay(new Date('2026-09-27T23:59:59.999Z'))).toBe('2026-09-27');
    expect(viewDay(new Date('2026-09-28T00:00:00+03:00'))).toBe('2026-09-27');
    expect(viewDay(new Date('2026-09-28T00:00:00.000Z'))).toBe('2026-09-28');
  });

  it('keeps a comment trimmed and capped, and treats a blank one as none', () => {
    expect(cleanComment('  It did not say what to do with Apple Pay. ')).toBe(
      'It did not say what to do with Apple Pay.',
    );
    expect(cleanComment('x'.repeat(1_500))).toHaveLength(1_000);
    expect(cleanComment('   ')).toBeNull();
    expect(cleanComment(undefined)).toBeNull();
  });
});

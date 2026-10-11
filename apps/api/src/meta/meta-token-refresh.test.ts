import { describe, expect, it } from 'vitest';
import { isRefreshDue, REFRESH_AFTER_MS } from './meta-token-refresh.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const instagram = {
  platform: 'instagram',
  tokenKind: 'instagram_user',
  tokenRefreshedAt: null,
  tokenUpdatedAt: ago(8 * 24 * 60 * 60 * 1000),
} as const;

describe('isRefreshDue', () => {
  it('is due once an Instagram token is a week old, from when it was saved', () => {
    expect(isRefreshDue(instagram, NOW)).toBe(true);
    expect(isRefreshDue({ ...instagram, tokenUpdatedAt: ago(REFRESH_AFTER_MS) }, NOW)).toBe(true);
    expect(isRefreshDue({ ...instagram, tokenUpdatedAt: ago(REFRESH_AFTER_MS - 1) }, NOW)).toBe(
      false,
    );
  });

  it('counts from the last renewal, not from when the token was saved', () => {
    expect(isRefreshDue({ ...instagram, tokenRefreshedAt: ago(60_000) }, NOW)).toBe(false);
    expect(isRefreshDue({ ...instagram, tokenRefreshedAt: ago(REFRESH_AFTER_MS + 1) }, NOW)).toBe(
      true,
    );
  });

  it('is never due for a token that does not expire', () => {
    expect(isRefreshDue({ ...instagram, platform: 'messenger', tokenKind: 'page' }, NOW)).toBe(
      false,
    );
    expect(
      isRefreshDue({ ...instagram, platform: 'whatsapp', tokenKind: 'system_user' }, NOW),
    ).toBe(false);
  });
});

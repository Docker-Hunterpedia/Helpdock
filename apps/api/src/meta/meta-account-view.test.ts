import type { MetaAccount as MetaAccountRow } from '@helpdock/db';
import { metaAccountSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { tokenHint, toMetaAccount } from './meta-account-view.js';

const TOKEN = 'EAAGsecretTokenEndingIn4f2a';

const account = (overrides: Partial<MetaAccountRow> = {}): MetaAccountRow => ({
  id: '01924f00-0000-7000-8000-0000000000aa',
  brandId: '01924f00-0000-7000-8000-000000000001',
  platform: 'messenger',
  departmentId: '01924f00-0000-7000-8000-000000000002',
  externalId: '104857223916604',
  wabaId: null,
  displayPhone: null,
  username: 'Helpdock',
  displayName: 'Helpdock',
  accessToken: 'v1.k1.ciphertext-that-must-not-leave',
  tokenKind: 'page',
  tokenExpiresAt: null,
  tokenRefreshedAt: null,
  tokenUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
  tokenUpdatedBy: null,
  humanAgentEnabled: false,
  subscribedFields: ['messages'],
  subscribedAt: new Date('2026-10-11T08:00:00.000Z'),
  subscriptionCheckedAt: null,
  status: 'connected',
  lastEventAt: new Date('2026-10-11T09:00:00.000Z'),
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date('2026-10-02T09:00:00.000Z'),
  updatedAt: new Date('2026-10-02T09:00:00.000Z'),
  ...overrides,
});

const view = (overrides: Partial<MetaAccountRow> = {}) =>
  toMetaAccount(
    { account: account(overrides), departmentName: 'Support', tokenUpdatedByName: 'Lina Haddad' },
    TOKEN,
  );

describe('tokenHint', () => {
  it('is the last four characters', () => {
    expect(tokenHint(TOKEN)).toBe('4f2a');
    expect(tokenHint('ab')).toBe('ab');
  });
});

describe('toMetaAccount', () => {
  it('is what the screen reads, and carries nothing of the token but its last four characters', () => {
    const shown = view();

    expect(metaAccountSchema.parse(shown)).toEqual(shown);
    expect(shown).toMatchObject({
      tokenSet: true,
      tokenHint: '4f2a',
      departmentName: 'Support',
      tokenUpdatedByName: 'Lina Haddad',
      tokenExpiresAt: null,
      health: 'healthy',
    });
    expect(JSON.stringify(shown)).not.toContain('ciphertext');
    expect(JSON.stringify(shown)).not.toContain(TOKEN);
  });

  it('reads health from the row: waiting before a message, failing once the token expired', () => {
    expect(view({ lastEventAt: null }).health).toBe('waiting');
    expect(view({ status: 'token_expired' }).health).toBe('failing');
    expect(
      view({
        lastError: 'Error validating access token',
        lastErrorAt: new Date('2026-10-11T10:00:00.000Z'),
      }).health,
    ).toBe('failing');
  });

  it('says no token is set for an empty column', () => {
    expect(view({ accessToken: '' }).tokenSet).toBe(false);
  });

  it('writes every instant as ISO text', () => {
    expect(view({ tokenExpiresAt: new Date('2026-12-01T00:00:00.000Z') })).toMatchObject({
      tokenExpiresAt: '2026-12-01T00:00:00.000Z',
      subscribedAt: '2026-10-11T08:00:00.000Z',
      createdAt: '2026-10-02T09:00:00.000Z',
    });
  });
});

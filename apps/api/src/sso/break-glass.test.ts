import { describe, expect, it } from 'vitest';
import {
  enforcementAllows,
  isBreakGlassEligible,
  passkeyCounts,
  passkeyHoldings,
} from './break-glass.js';

const SECOND_FACTORS = [
  'totp',
  'passkey',
  'recovery-code',
  'trusted-browser',
  'passkey-uv',
  'idp',
  null,
] as const;

describe('what SSO enforcement allows', () => {
  it.each([
    ['totp', true],
    ['passkey', true],
    ['recovery-code', false],
    ['trusted-browser', false],
    ['passkey-uv', false],
    ['idp', false],
    [null, false],
  ] as const)('after a break-glass password, %s is %s', (second, allowed) => {
    expect(enforcementAllows('password', second)).toBe(allowed);
  });

  it.each([
    ['totp', true],
    ['passkey', true],
    ['idp', true],
    [null, true],
    ['recovery-code', false],
    ['trusted-browser', false],
  ] as const)('after an SSO assertion, %s is %s', (second, allowed) => {
    expect(enforcementAllows('sso', second)).toBe(allowed);
  });

  it.each(['magic-link', 'oauth', 'passkey', 'unknown', ''])(
    'refuses every second factor after %j',
    (first) => {
      for (const second of SECOND_FACTORS) expect(enforcementAllows(first, second)).toBe(false);
    },
  );
});

describe('who may be a break-glass admin', () => {
  const eligible = {
    installAdmin: true,
    status: 'active',
    passwordHash: 'hash',
    totpEnabled: true,
    totpSecretEncrypted: 'secret',
  } as const;

  it('takes an active install admin with a password and an authenticator app', () => {
    expect(isBreakGlassEligible(eligible, 0)).toBe(true);
  });

  it('takes the same admin with only a passkey', () => {
    expect(
      isBreakGlassEligible({ ...eligible, totpEnabled: false, totpSecretEncrypted: null }, 1),
    ).toBe(true);
  });

  it.each([
    ['no password', { passwordHash: null }, 1],
    ['no second factor', { totpEnabled: false, totpSecretEncrypted: null }, 0],
    ['an app switched on without a stored secret', { totpSecretEncrypted: null }, 0],
    ['not an install admin', { installAdmin: false }, 1],
    ['a deactivated account', { status: 'deactivated' as const }, 1],
    ['an invited account', { status: 'invited' as const }, 1],
  ])('refuses %s', (_label, change, passkeys) => {
    expect(isBreakGlassEligible({ ...eligible, ...change }, passkeys)).toBe(false);
  });
});

describe('counting passkeys', () => {
  const rows = [
    { userId: 'a', verified: 2, unverified: 1 },
    { userId: 'b', verified: 0, unverified: 3 },
  ];
  const txReturning = (result: unknown[]) => ({
    select: () => ({
      from: () => ({ where: () => ({ groupBy: () => Promise.resolve(result) }) }),
    }),
  });

  it('reports verified and unverified keys apart', async () => {
    await expect(passkeyHoldings(txReturning(rows) as never, ['a', 'b'])).resolves.toEqual(
      new Map([
        ['a', { verified: 2, unverified: 1 }],
        ['b', { verified: 0, unverified: 3 }],
      ]),
    );
  });

  it('counts only the keys that gave user verification', async () => {
    await expect(passkeyCounts(txReturning(rows) as never, ['a', 'b'])).resolves.toEqual(
      new Map([
        ['a', 2],
        ['b', 0],
      ]),
    );
  });

  it('leaves an admin with only unverified keys ineligible', () => {
    const admin = {
      installAdmin: true,
      status: 'active',
      passwordHash: 'hash',
      totpEnabled: false,
      totpSecretEncrypted: null,
    } as const;

    expect(isBreakGlassEligible(admin, 0)).toBe(false);
  });

  it('asks nothing of the database for no accounts', async () => {
    const tx = {
      select: () => {
        throw new Error('queried');
      },
    };

    await expect(passkeyCounts(tx as never, [])).resolves.toEqual(new Map());
  });
});

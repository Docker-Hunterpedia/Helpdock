import type { DbTransaction, User } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/auth.service.js';
import type { PasskeyService } from '../auth/passkeys/passkey.service.js';
import { createLogger } from '../logging/logger.js';
import { SecondFactorResetService } from './second-factor-reset.service.js';
import type { StaffRepository } from './staff.repository.js';
import { StaffFailure } from './staff-failure.js';

/**
 * The order of the refusals is part of the contract: the ones that need no proof
 * come before the admin's step-up, so they spend no attempt from the shared
 * budget. The effects (one transaction, the audit row, the notice) are proved
 * against Postgres in `second-factor-reset.integration.test.ts`.
 */

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

const user = (overrides: Partial<User>): User =>
  ({
    status: 'active',
    installAdmin: false,
    totpEnabled: true,
    totpSecretEncrypted: 'sealed',
    recoveryCodesHashed: ['a', 'b'],
    name: 'Someone',
    ...overrides,
  }) as User;

const setup = (
  options: {
    actor?: Partial<User>;
    target?: Partial<User>;
    passkeys?: string[];
    allowed?: boolean;
    lastBreakGlass?: boolean;
    required?: boolean;
  } = {},
) => {
  const events: string[] = [];
  const stored = {
    [ACTOR]: user({ installAdmin: true, ...options.actor }),
    [TARGET]: user(options.target ?? {}),
  };
  const insertedAudit: unknown[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ id: '33333333-3333-4333-8333-333333333333' }]),
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        events.push('audit');
        insertedAudit.push(value);
        return Promise.resolve();
      },
    }),
    execute: vi.fn().mockResolvedValue([{ value: '{00000000-0000-0000-0000-000000000000}' }]),
  } as unknown as DbTransaction;
  const staff = {
    findUser: (_tx: unknown, id: string) => Promise.resolve(stored[id as keyof typeof stored]),
  } as unknown as StaffRepository;
  const auth = {
    confirmWithSecret: vi.fn(() => {
      events.push('step-up');
      return Promise.resolve();
    }),
    resetSecondFactorOf: vi.fn(() => {
      events.push('reset');
      return Promise.resolve();
    }),
    isSecondFactorRequired: vi.fn(() => Promise.resolve(options.required ?? true)),
    notifyCredentialChange: vi.fn(() => {
      events.push('notice');
      return Promise.resolve();
    }),
  };
  const passkeys = {
    lockAccount: vi.fn((_id: string) => {
      events.push('lock');
      return Promise.resolve();
    }),
    idsOf: vi.fn(() => Promise.resolve(options.passkeys ?? ['p1', 'p2'])),
    removeAllOf: vi.fn(() => {
      events.push('passkeys');
      return Promise.resolve((options.passkeys ?? ['p1', 'p2']).length);
    }),
    sessionOf: vi.fn(),
    confirmStepUp: vi.fn(() => {
      events.push('step-up');
      return Promise.resolve();
    }),
  };
  const limiter = { consume: vi.fn(() => Promise.resolve(options.allowed ?? true)) };
  const ssoPolicy = {
    isLastBreakGlass: vi.fn(() => Promise.resolve(options.lastBreakGlass ?? false)),
  };
  const service = new SecondFactorResetService({
    staff,
    auth: auth as unknown as AuthService,
    passkeys: passkeys as unknown as PasskeyService,
    ssoPolicy,
    limiter,
    logger: createLogger({
      env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      level: 'silent',
      destination: { write: () => {} },
    }),
  });

  return { service, tx, events, auth, passkeys, limiter, ssoPolicy, insertedAudit };
};

const reasonOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof StaffFailure ? error.reason : `not a StaffFailure: ${String(error)}`;
  }
};

const digestFor = async (): Promise<string> => {
  const { service, tx } = setup();
  return (await service.summary(tx, ACTOR, TARGET)).digest;
};

const resetOf = async (
  fixture: ReturnType<typeof setup>,
  digest: string,
  proof: { currentPassword: string } = { currentPassword: 'pw' },
) =>
  fixture.service.reset({
    tx: fixture.tx,
    actorId: ACTOR,
    targetId: TARGET,
    authorization: undefined,
    request: { proof, digest },
  });

describe('SecondFactorResetService', () => {
  it('lists what a reset removes, with a digest of exactly that set', async () => {
    const { service, tx } = setup();

    const shown = await service.summary(tx, ACTOR, TARGET);

    expect(shown).toMatchObject({ totp: true, passkeys: 2, recoveryCodes: 2 });
    expect(shown.digest).toMatch(/^[0-9a-f]{64}$/);
    const fewer = setup({ passkeys: ['p1'] });
    expect((await fewer.service.summary(fewer.tx, ACTOR, TARGET)).digest).not.toBe(shown.digest);
    const codes = setup({ target: { recoveryCodesHashed: ['a'] } });
    expect((await codes.service.summary(codes.tx, ACTOR, TARGET)).digest).not.toBe(shown.digest);
  });

  it('removes everything, then writes the audit row and the notice, once the proof is spent', async () => {
    const fixture = setup();

    const removed = await resetOf(fixture, await digestFor());

    expect(removed).toEqual({ totp: true, passkeys: 2, recoveryCodes: 2 });
    expect(fixture.events).toEqual([
      'lock',
      'lock',
      'step-up',
      'passkeys',
      'reset',
      'audit',
      'notice',
    ]);
    expect(fixture.insertedAudit[0]).toMatchObject({
      action: 'auth.second_factor.reset',
      actorId: ACTOR,
      targetId: TARGET,
      meta: { totp: true, passkeys: 2, recoveryCodes: 2 },
    });
    expect(fixture.auth.notifyCredentialChange).toHaveBeenCalledWith(
      TARGET,
      'secondFactorReset',
      fixture.tx,
      { actor: 'Someone', required: '1' },
    );
  });

  it('locks both account rows in id order before the proof, so two admins resetting each other cannot deadlock', async () => {
    const fixture = setup();

    await resetOf(fixture, await digestFor());

    expect(fixture.passkeys.lockAccount.mock.calls.map(([id]) => id)).toEqual([ACTOR, TARGET]);
    expect(fixture.events.indexOf('step-up')).toBeGreaterThan(fixture.events.lastIndexOf('lock'));
  });

  it('says in the summary and the notice whether the role requires a second factor', async () => {
    const optional = setup({ required: false });

    expect(await optional.service.summary(optional.tx, ACTOR, TARGET)).toMatchObject({
      enrolmentRequired: false,
    });
    await resetOf(optional, (await optional.service.summary(optional.tx, ACTOR, TARGET)).digest);
    expect(optional.auth.notifyCredentialChange).toHaveBeenCalledWith(
      TARGET,
      'secondFactorReset',
      optional.tx,
      { actor: 'Someone', required: '0' },
    );
  });

  it('refuses an admin acting on themselves before the limiter or the proof', async () => {
    const fixture = setup();

    const reason = await reasonOf(
      fixture.service.reset({
        tx: fixture.tx,
        actorId: ACTOR,
        targetId: ACTOR,
        authorization: undefined,
        request: { proof: { currentPassword: 'pw' }, digest: 'a'.repeat(64) },
      }),
    );

    expect(reason).toBe('self');
    expect(fixture.limiter.consume).not.toHaveBeenCalled();
    expect(fixture.auth.confirmWithSecret).not.toHaveBeenCalled();
  });

  it('refuses when the limiter says no, before looking at the person', async () => {
    const fixture = setup({ allowed: false });

    expect(await reasonOf(resetOf(fixture, await digestFor()))).toBe('reset-rate-limited');
    expect(fixture.passkeys.lockAccount).not.toHaveBeenCalled();
  });

  it('refuses a caller whose row is no longer an active install admin', async () => {
    for (const actor of [{ installAdmin: false }, { status: 'deactivated' as const }]) {
      const fixture = setup({ actor });
      expect(await reasonOf(resetOf(fixture, await digestFor()))).toBe('out-of-scope');
      expect(fixture.auth.resetSecondFactorOf).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['has no second factor', { target: { totpEnabled: false }, passkeys: [] }],
    ['is deactivated', { target: { status: 'deactivated' as const } }],
    ['is only invited', { target: { status: 'invited' as const } }],
  ])('refuses a person who %s, without spending a step-up attempt', async (_label, options) => {
    const fixture = setup(options);

    expect(await reasonOf(resetOf(fixture, 'a'.repeat(64)))).toBe('not-resettable');
    expect(await reasonOf(fixture.service.summary(fixture.tx, ACTOR, TARGET))).toBe(
      'not-resettable',
    );
    expect(fixture.auth.confirmWithSecret).not.toHaveBeenCalled();
  });

  it('counts a person with only passkeys as having a second factor', async () => {
    const fixture = setup({ target: { totpEnabled: false, totpSecretEncrypted: null } });
    const { digest } = await fixture.service.summary(fixture.tx, ACTOR, TARGET);

    expect(await resetOf(fixture, digest)).toMatchObject({ totp: false, passkeys: 2 });
  });

  it('answers changed when the digest is not the one the admin confirmed, before the proof', async () => {
    const fixture = setup();

    expect(await reasonOf(resetOf(fixture, 'a'.repeat(64)))).toBe('second-factor-changed');
    expect(fixture.auth.confirmWithSecret).not.toHaveBeenCalled();
    expect(fixture.passkeys.removeAllOf).not.toHaveBeenCalled();
  });

  it('refuses the last break-glass admin before the proof', async () => {
    const fixture = setup({ lastBreakGlass: true });

    expect(await reasonOf(resetOf(fixture, await digestFor()))).toBe('last-break-glass');
    expect(fixture.auth.confirmWithSecret).not.toHaveBeenCalled();
    expect(fixture.ssoPolicy.isLastBreakGlass).toHaveBeenCalledWith(TARGET, fixture.tx);
  });

  it('removes nothing when the step-up fails', async () => {
    const fixture = setup();
    fixture.auth.confirmWithSecret.mockRejectedValueOnce(new Error('invalid-credentials'));

    await expect(resetOf(fixture, await digestFor())).rejects.toThrow('invalid-credentials');
    expect(fixture.passkeys.removeAllOf).not.toHaveBeenCalled();
    expect(fixture.auth.resetSecondFactorOf).not.toHaveBeenCalled();
    expect(fixture.insertedAudit).toHaveLength(0);
  });

  it('proves a passkey step-up against the admin session, not the target', async () => {
    const fixture = setup();
    const session = { userId: ACTOR, familyId: 'f', tx: fixture.tx };
    fixture.passkeys.sessionOf.mockResolvedValueOnce(session);
    const passkey = { ceremonyId: 'c'.repeat(43), response: {} } as never;

    await fixture.service.reset({
      tx: fixture.tx,
      actorId: ACTOR,
      targetId: TARGET,
      authorization: 'Bearer token',
      request: { proof: { passkey }, digest: await digestFor() },
    });

    expect(fixture.passkeys.sessionOf).toHaveBeenCalledWith(ACTOR, 'Bearer token', fixture.tx);
    expect(fixture.passkeys.confirmStepUp).toHaveBeenCalledWith(session, passkey);
    expect(fixture.auth.confirmWithSecret).not.toHaveBeenCalled();
  });
});

import { randomBytes } from 'node:crypto';
import type { DbTransaction, WebauthnCredential } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import { generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import { MemoryRpIdPin } from '../../testing/memory-rp-id-pin.js';
import { silentLogger } from '../../testing/silent-logger.js';
import { SoftwareAuthenticator } from '../../testing/software-authenticator.js';
import type { AuthService } from '../auth.service.js';
import { AuthFailure } from '../auth-failure.js';
import type { RateLimiter } from '../rate-limit.js';
import { issueAccessToken } from '../session/access-token.js';
import type { SigningKeys } from '../session/signing-keys.js';
import type { StaffUser } from '../staff.repository.js';
import { WebAuthnCeremonyStore } from '../webauthn/ceremony-store.js';
import { WebAuthnService } from '../webauthn/webauthn.service.js';
import type { PasskeyRepository } from './passkey.repository.js';
import { PasskeyService, type PasskeySession } from './passkey.service.js';

type CreationOptions = Parameters<SoftwareAuthenticator['register']>[0];

const APP_URL = 'https://desk.example.com';
const tx = {} as DbTransaction;
const userId = uuidv7();
const familyId = uuidv7();
const session: PasskeySession = { userId, familyId, tx };

/** The slice of `AuthService` the passkey service borrows, recording what it is asked. */
class FakeAuth {
  user = { id: userId, email: 'lina@example.com', name: 'Lina', totpEnabled: false } as StaffUser;
  required = false;
  secretProofs: unknown[] = [];
  attempts = 0;
  events: { action: string; actor: string; meta: unknown }[] = [];
  notices: { change: string; values: Record<string, string> }[] = [];
  refuseSecret = false;
  cleared = 0;
  redrawn = 0;

  issueRecoveryCodes = vi.fn(() => Promise.resolve(['AAAA-1111', 'BBBB-2222']));
  clearRecoveryCodes = vi.fn(() => {
    this.cleared += 1;
    return Promise.resolve();
  });
  regenerateRecoveryCodesAfterPasskey = vi.fn(() => {
    this.redrawn += 1;
    return Promise.resolve({ recoveryCodes: ['CCCC-3333'] });
  });

  /** Accounts that must have a second factor, for `secondFactorRequiredFor`. */
  requiredIds = new Set<string>();
  secondFactorRequiredFor = vi.fn((id: string) => Promise.resolve(this.requiredIds.has(id)));
  activeAccount = vi.fn(() => Promise.resolve(this.user));
  isSecondFactorRequired = vi.fn(() => Promise.resolve(this.required));
  confirmWithSecret = vi.fn((_id: string, proof: unknown) => {
    this.secretProofs.push(proof);
    return this.refuseSecret
      ? Promise.reject(new AuthFailure('invalid-credentials'))
      : Promise.resolve(this.user);
  });
  spendStepUpAttempt = vi.fn(() => {
    this.attempts += 1;
    return Promise.resolve();
  });
  recordCredentialEvent = vi.fn((action: string, _id: string, actor: string, meta?: unknown) => {
    this.events.push({ action, actor, meta });
    return Promise.resolve();
  });
  notifyCredentialChange = vi.fn(
    (_id: string, change: string, _tx: unknown, values: Record<string, string>) => {
      this.notices.push({ change, values });
      return Promise.resolve();
    },
  );
}

/** An in-memory `webauthn_credentials`, keyed like the table. */
class FakeRows {
  rows: WebauthnCredential[] = [];
  locked = 0;

  ofUser = (id: string) => Promise.resolve(this.rows.filter((row) => row.userId === id));
  find = (id: string, rowId: string) =>
    Promise.resolve(this.rows.find((row) => row.userId === id && row.id === rowId));
  byCredentialId = (credentialId: Uint8Array) =>
    Promise.resolve(
      this.rows.find((row) => Buffer.from(row.credentialId).equals(Buffer.from(credentialId))),
    );
  lockAccount = () => {
    this.locked += 1;
    return Promise.resolve();
  };
  userHandle = () => Promise.resolve(new Uint8Array(randomBytes(32)));
  count = (id: string) => Promise.resolve(this.rows.filter((row) => row.userId === id).length);
  add = (
    owner: string,
    name: string,
    passkey: { credentialId: Uint8Array; publicKey: Uint8Array },
  ) => {
    if (
      this.rows.some((row) =>
        Buffer.from(row.credentialId).equals(Buffer.from(passkey.credentialId)),
      )
    ) {
      return Promise.resolve('duplicate' as const);
    }
    const row = rowFor(owner, name, passkey.credentialId, passkey.publicKey);
    this.rows.push(row);
    return Promise.resolve(row);
  };
  rename = (owner: string, rowId: string, name: string) => {
    const index = this.rows.findIndex((found) => found.userId === owner && found.id === rowId);
    const row = this.rows[index];
    if (row === undefined) return Promise.resolve(undefined);
    // A copy, as a database row would be: the caller's earlier read keeps the old name.
    const renamed = { ...row, name };
    this.rows[index] = renamed;
    return Promise.resolve(renamed);
  };
  remove = (owner: string, rowId: string) => {
    const row = this.rows.find((found) => found.userId === owner && found.id === rowId);
    this.rows = this.rows.filter((found) => found !== row);
    return Promise.resolve(row);
  };
  markUsed = vi.fn(() => Promise.resolve());
  /** Who `holders` reports as also having an authenticator app. */
  withApp = new Set<string>();
  totals = () =>
    Promise.resolve({
      passkeys: this.rows.length,
      holders: new Set(this.rows.map((row) => row.userId)).size,
    });
  holders = () => {
    const counts = new Map<string, number>();
    for (const row of this.rows) counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
    return Promise.resolve(
      [...counts].map(([holder, passkeys]) => ({
        userId: holder,
        passkeys,
        totpEnabled: this.withApp.has(holder),
      })),
    );
  };
  removeAll = () => {
    const removed = this.rows.length;
    this.rows = [];
    return Promise.resolve(removed);
  };
}

const rowFor = (
  owner: string,
  name: string,
  credentialId: Uint8Array,
  publicKey: Uint8Array,
): WebauthnCredential => ({
  id: uuidv7(),
  userId: owner,
  credentialId,
  publicKey,
  algorithm: -7,
  signCount: 0,
  transports: ['internal'],
  aaguid: null,
  discoverable: true,
  backupEligible: false,
  backedUp: false,
  userVerified: true,
  name,
  createdAt: new Date('2026-10-20T10:00:00Z'),
  lastUsedAt: null,
});

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AuthFailure ? error.auth.code : `not an AuthFailure: ${String(error)}`;
  }
};

let auth: FakeAuth;
let rows: FakeRows;
let limiterAllows: boolean;
let signingKeys: SigningKeys;
let service: PasskeyService;
let pin: MemoryRpIdPin;
let breakGlassLost: number;

beforeEach(async () => {
  auth = new FakeAuth();
  rows = new FakeRows();
  pin = new MemoryRpIdPin();
  breakGlassLost = 0;
  limiterAllows = true;
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  signingKeys = { kid: 'k1', privateKey, publicKey };
  service = new PasskeyService({
    auth: auth as unknown as AuthService,
    webauthn: new WebAuthnService({
      appUrl: APP_URL,
      ceremonies: new WebAuthnCeremonyStore(authRedis().redis),
      pin,
    }),
    passkeys: rows as unknown as PasskeyRepository,
    ssoPolicy: { breakGlassLosingPasskeys: () => Promise.resolve(breakGlassLost) },
    limiter: { consume: () => Promise.resolve(limiterAllows) } as unknown as RateLimiter,
    signingKeys,
    logger: silentLogger(),
  });
});

const password = { currentPassword: 'a password' };

const addOne = async (authenticator: SoftwareAuthenticator, name = 'Key') => {
  const { ceremonyId, options } = await service.beginRegistration(session, password);
  return service.finishRegistration(session, {
    ceremonyId,
    response: authenticator.register(options as unknown as CreationOptions, {
      origin: APP_URL,
    }) as never,
    name,
  });
};

describe('sessionOf', () => {
  const tokenFor = (sub: string) =>
    issueAccessToken(
      { userId: sub, sessionId: uuidv7(), familyId, brands: {}, installAdmin: false },
      signingKeys,
    );

  it('reads the browser session out of the caller’s own token', async () => {
    const found = await service.sessionOf(userId, `Bearer ${await tokenFor(userId)}`, tx);

    expect(found).toEqual({ userId, familyId, tx });
  });

  it.each([
    ['no header', undefined],
    ['a header that is not a bearer token', 'Basic abc'],
    ['a token that does not verify', 'Bearer not.a.jwt'],
  ])('refuses %s', async (_label, header) => {
    await expect(service.sessionOf(userId, header, tx)).rejects.toThrow('Authentication');
  });

  it('refuses a token of another person than the principal', async () => {
    await expect(
      service.sessionOf(userId, `Bearer ${await tokenFor(uuidv7())}`, tx),
    ).rejects.toThrow('Authentication');
  });

  it('refuses a token that claims the principal but is signed by another key', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const forged = await issueAccessToken(
      { userId, sessionId: uuidv7(), familyId, brands: {}, installAdmin: false },
      { kid: 'not-this-install', privateKey, publicKey },
    );

    await expect(service.sessionOf(userId, `Bearer ${forged}`, tx)).rejects.toThrow(
      'Authentication',
    );
  });

  it('refuses an unsigned token that claims the principal', async () => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = [part({ alg: 'none', typ: 'JWT' }), part({ sub: userId }), ''].join('.');

    await expect(service.sessionOf(userId, `Bearer ${unsigned}`, tx)).rejects.toThrow(
      'Authentication',
    );
  });
});

describe('beginRegistration', () => {
  it('answers the step-up with a secret through the shared budget, before minting options', async () => {
    await service.beginRegistration(session, { code: '123456' });

    expect(auth.secretProofs).toEqual([{ code: '123456' }]);
    expect(auth.attempts).toBe(0);
  });

  it('refuses a wrong secret and mints nothing', async () => {
    auth.refuseSecret = true;

    expect(await codeOf(service.beginRegistration(session, password))).toBe('invalid-credentials');
  });

  it('refuses the eleventh passkey without asking for a proof', async () => {
    for (let held = 0; held < 10; held += 1) {
      const key = new SoftwareAuthenticator();
      rows.rows.push(rowFor(userId, `Key ${held}`, key.credentialId, key.cosePublicKey));
    }

    expect(await codeOf(service.beginRegistration(session, password))).toBe('passkey-limit');
    expect(auth.confirmWithSecret).not.toHaveBeenCalled();
  });

  it('excludes the credentials the account already holds', async () => {
    const key = new SoftwareAuthenticator();
    rows.rows.push(rowFor(userId, 'Held', key.credentialId, key.cosePublicKey));

    const { options } = await service.beginRegistration(session, password);

    expect((options as { excludeCredentials: unknown[] }).excludeCredentials).toHaveLength(1);
  });

  it('stops options being minted past the budget', async () => {
    limiterAllows = false;

    expect(await codeOf(service.beginRegistration(session, password))).toBe('rate-limited');
  });
});

describe('finishRegistration', () => {
  it('stores the passkey under the chosen name, audits it and queues the notice', async () => {
    const stored = await addOne(new SoftwareAuthenticator(), 'MacBook');

    expect(stored).toMatchObject({ name: 'MacBook', lastUsedAt: null, synced: false });
    expect(auth.events).toEqual([
      {
        action: 'auth.passkey.added',
        actor: 'staff',
        meta: { passkey: stored.id, name: 'MacBook', synced: false },
      },
    ]);
    expect(auth.notices).toEqual([
      { change: 'passkeyAdded', values: expect.objectContaining({ passkey: 'MacBook' }) },
    ]);
    expect(rows.locked).toBe(1);
  });

  it('draws the recovery codes with the first second factor of either kind, once', async () => {
    const first = await addOne(new SoftwareAuthenticator(), 'First');
    const second = await addOne(new SoftwareAuthenticator(), 'Second');

    expect(first.recoveryCodes).toEqual(['AAAA-1111', 'BBBB-2222']);
    expect(second.recoveryCodes).toBeUndefined();
    expect(auth.issueRecoveryCodes).toHaveBeenCalledOnce();
  });

  it('draws none for an account that already has an authenticator app', async () => {
    auth.user = { ...auth.user, totpEnabled: true } as StaffUser;

    const stored = await addOne(new SoftwareAuthenticator(), 'Beside the app');

    expect(stored.recoveryCodes).toBeUndefined();
    expect(auth.issueRecoveryCodes).not.toHaveBeenCalled();
  });

  it('spends the ceremony: a second finish with it finds nothing', async () => {
    const authenticator = new SoftwareAuthenticator();
    const { ceremonyId, options } = await service.beginRegistration(session, password);
    const input = {
      ceremonyId,
      response: authenticator.register(options as unknown as CreationOptions, {
        origin: APP_URL,
      }) as never,
      name: 'Once',
    };

    await service.finishRegistration(session, input);

    expect(await codeOf(service.finishRegistration(session, input))).toBe('challenge-expired');
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses a ceremony another browser session began', async () => {
    const authenticator = new SoftwareAuthenticator();
    const { ceremonyId, options } = await service.beginRegistration(session, password);

    const code = await codeOf(
      service.finishRegistration(
        { ...session, familyId: uuidv7() },
        {
          ceremonyId,
          response: authenticator.register(options as unknown as CreationOptions, {
            origin: APP_URL,
          }) as never,
          name: 'Borrowed',
        },
      ),
    );

    expect(code).toBe('challenge-expired');
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses an answer for another origin and stores and says nothing', async () => {
    const authenticator = new SoftwareAuthenticator();
    const { ceremonyId, options } = await service.beginRegistration(session, password);

    const code = await codeOf(
      service.finishRegistration(session, {
        ceremonyId,
        response: authenticator.register(options as unknown as CreationOptions, {
          origin: 'https://evil.example',
        }) as never,
        name: 'Phished',
      }),
    );

    expect(code).toBe('invalid-credentials');
    expect(rows.rows).toHaveLength(0);
    expect(auth.events).toEqual([]);
    expect(auth.notices).toEqual([]);
  });

  it('refuses an authenticator that is already stored', async () => {
    const authenticator = new SoftwareAuthenticator();
    await addOne(authenticator);

    expect(await codeOf(addOne(authenticator, 'Again'))).toBe('passkey-duplicate');
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses when another request took the last place meanwhile', async () => {
    const { ceremonyId, options } = await service.beginRegistration(session, password);
    for (let held = 0; held < 10; held += 1) {
      const key = new SoftwareAuthenticator();
      rows.rows.push(rowFor(userId, `Key ${held}`, key.credentialId, key.cosePublicKey));
    }

    const code = await codeOf(
      service.finishRegistration(session, {
        ceremonyId,
        response: new SoftwareAuthenticator().register(options as unknown as CreationOptions, {
          origin: APP_URL,
        }) as never,
        name: 'Late',
      }),
    );

    expect(code).toBe('passkey-limit');
  });
});

describe('stepUpOptions', () => {
  it('is refused when the account holds no passkey', async () => {
    expect(await codeOf(service.stepUpOptions(session))).toBe('invalid-credentials');
  });

  it('offers only this account’s passkeys', async () => {
    const mine = new SoftwareAuthenticator();
    const theirs = new SoftwareAuthenticator();
    rows.rows.push(rowFor(userId, 'Mine', mine.credentialId, mine.cosePublicKey));
    rows.rows.push(rowFor(uuidv7(), 'Theirs', theirs.credentialId, theirs.cosePublicKey));

    const { options } = await service.stepUpOptions(session);

    expect((options as { allowCredentials: { id: string }[] }).allowCredentials).toEqual([
      expect.objectContaining({ id: Buffer.from(mine.credentialId).toString('base64url') }),
    ]);
  });
});

describe('a passkey as the step-up', () => {
  const holder = new SoftwareAuthenticator();

  const proofFrom = async (authenticator: SoftwareAuthenticator, origin = APP_URL) => {
    const { ceremonyId, options } = await service.stepUpOptions(session);
    return {
      passkey: {
        ceremonyId,
        response: authenticator.assert(options as never, { origin }) as never,
      },
    };
  };

  beforeEach(() => {
    rows.rows.push(rowFor(userId, 'Held', holder.credentialId, holder.cosePublicKey));
  });

  it('spends one step-up attempt, accepts the assertion and records the use', async () => {
    holder.signCount = 5;
    const id = rows.rows[0]?.id ?? '';

    const renamed = await service.rename(session, id, 'Renamed', await proofFrom(holder));

    expect(renamed.name).toBe('Renamed');
    expect(auth.attempts).toBe(1);
    expect(rows.markUsed).toHaveBeenCalledOnce();
    expect(auth.confirmWithSecret).not.toHaveBeenCalled();
  });

  it('refuses another account’s passkey, audits why, and renames nothing', async () => {
    const stranger = new SoftwareAuthenticator();
    rows.rows.push(rowFor(uuidv7(), 'Stranger', stranger.credentialId, stranger.cosePublicKey));
    const id = rows.rows[0]?.id ?? '';

    const code = await codeOf(service.rename(session, id, 'Hijacked', await proofFrom(stranger)));

    expect(code).toBe('invalid-credentials');
    expect(rows.rows[0]?.name).toBe('Held');
    expect(auth.events).toContainEqual({
      action: 'auth.step_up.refused',
      actor: 'system',
      meta: { reason: 'passkey-wrong-user' },
    });
  });

  it('refuses an assertion for another origin', async () => {
    const id = rows.rows[0]?.id ?? '';

    const code = await codeOf(
      service.rename(session, id, 'Phished', await proofFrom(holder, 'https://evil.example')),
    );

    expect(code).toBe('invalid-credentials');
    expect(auth.events).toContainEqual({
      action: 'auth.step_up.refused',
      actor: 'system',
      meta: { reason: 'passkey-bad-assertion' },
    });
  });

  it('audits a counter that went backwards, in addition to refusing it', async () => {
    const [held] = rows.rows;
    if (held) held.signCount = 9;
    holder.signCount = 2;
    const id = rows.rows[0]?.id ?? '';

    const code = await codeOf(service.rename(session, id, 'Cloned', await proofFrom(holder)));

    expect(code).toBe('invalid-credentials');
    expect(auth.events).toContainEqual({
      action: 'auth.passkey.counter_regressed',
      actor: 'system',
      meta: { passkey: rows.rows[0]?.id },
    });
  });
});

describe('rename', () => {
  it('records the old and new names, and nothing for an unchanged one', async () => {
    const key = new SoftwareAuthenticator();
    const row = rowFor(userId, 'Old', key.credentialId, key.cosePublicKey);
    rows.rows.push(row);

    await service.rename(session, row.id, 'New', password);
    await service.rename(session, row.id, 'New', password);

    expect(auth.events).toEqual([
      {
        action: 'auth.passkey.renamed',
        actor: 'staff',
        meta: { passkey: row.id, from: 'Old', to: 'New' },
      },
    ]);
  });

  it('answers 404 for a passkey that is not the caller’s, before asking for a proof', async () => {
    const key = new SoftwareAuthenticator();
    const theirs = rowFor(uuidv7(), 'Theirs', key.credentialId, key.cosePublicKey);
    rows.rows.push(theirs);

    await expect(service.rename(session, theirs.id, 'Mine', password)).rejects.toThrow(
      'No such passkey',
    );
    expect(auth.confirmWithSecret).not.toHaveBeenCalled();
    expect(theirs.name).toBe('Theirs');
  });
});

describe('remove', () => {
  const hold = (name: string) => {
    const key = new SoftwareAuthenticator();
    const row = rowFor(userId, name, key.credentialId, key.cosePublicKey);
    rows.rows.push(row);
    return row;
  };

  it('removes one, audits its name and tells the holder what is left', async () => {
    hold('Laptop');
    const second = hold('YubiKey');
    auth.user = { ...auth.user, totpEnabled: true } as StaffUser;

    await service.remove(session, second.id, password);

    expect(rows.rows).toHaveLength(1);
    expect(auth.events).toEqual([
      {
        action: 'auth.passkey.removed',
        actor: 'staff',
        meta: { passkey: second.id, name: 'YubiKey' },
      },
    ]);
    expect(auth.notices).toEqual([
      {
        change: 'passkeyRemoved',
        values: { passkey: 'YubiKey', remaining: '1', totp: '1' },
      },
    ]);
  });

  it('refuses the last second factor of an account that must have one, spending no attempt', async () => {
    const only = hold('Only');
    auth.required = true;

    expect(await codeOf(service.remove(session, only.id, password))).toBe('second-factor-required');
    expect(rows.rows).toHaveLength(1);
    expect(auth.confirmWithSecret).not.toHaveBeenCalled();
  });

  it.each([
    ['an authenticator app is on', { totp: true, required: true, others: 0 }],
    ['the account need not have one', { totp: false, required: false, others: 0 }],
    ['another passkey remains', { totp: false, required: true, others: 1 }],
  ])('allows it when %s', async (_label, { totp, required, others }) => {
    const first = hold('First');
    for (let extra = 0; extra < others; extra += 1) hold(`Other ${extra}`);
    auth.user = { ...auth.user, totpEnabled: totp } as StaffUser;
    auth.required = required;

    await service.remove(session, first.id, password);

    expect(rows.rows).toHaveLength(others);
  });

  it('forgets the recovery codes when the last second factor goes, and only then', async () => {
    const first = hold('First');
    const second = hold('Second');

    await service.remove(session, first.id, password);
    expect(auth.cleared).toBe(0);
    await service.remove(session, second.id, password);
    expect(auth.cleared).toBe(1);
  });

  it('keeps the recovery codes while an authenticator app remains', async () => {
    const only = hold('Only');
    auth.user = { ...auth.user, totpEnabled: true } as StaffUser;

    await service.remove(session, only.id, password);

    expect(auth.cleared).toBe(0);
  });

  it('answers 404 for another account’s passkey and removes nothing', async () => {
    const key = new SoftwareAuthenticator();
    rows.rows.push(rowFor(uuidv7(), 'Theirs', key.credentialId, key.cosePublicKey));

    await expect(service.remove(session, rows.rows[0]?.id ?? '', password)).rejects.toThrow(
      'No such passkey',
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('leaves the passkey and sends nothing when the proof is wrong', async () => {
    const only = hold('Only');
    auth.refuseSecret = true;

    expect(await codeOf(service.remove(session, only.id, password))).toBe('invalid-credentials');
    expect(rows.rows).toHaveLength(1);
    expect(auth.notices).toEqual([]);
  });
});

describe('regenerateRecoveryCodes', () => {
  const holder = new SoftwareAuthenticator();

  const redrawProof = async (authenticator: SoftwareAuthenticator, origin = APP_URL) => {
    const { ceremonyId, options } = await service.stepUpOptions(session);
    return {
      passkey: {
        ceremonyId,
        response: authenticator.assert(options as never, { origin }) as never,
      },
    };
  };

  beforeEach(() => {
    rows.rows.push(rowFor(userId, 'Held', holder.credentialId, holder.cosePublicKey));
  });

  it('redraws after an assertion from a held passkey, under the account lock and one step-up attempt', async () => {
    const codes = await service.regenerateRecoveryCodes(session, await redrawProof(holder));

    expect(codes).toEqual({ recoveryCodes: ['CCCC-3333'] });
    expect(rows.locked).toBe(1);
    expect(auth.attempts).toBe(1);
    expect(auth.redrawn).toBe(1);
  });

  it('redraws nothing for another account’s passkey', async () => {
    const stranger = new SoftwareAuthenticator();
    rows.rows.push(rowFor(uuidv7(), 'Stranger', stranger.credentialId, stranger.cosePublicKey));

    const code = await codeOf(
      service.regenerateRecoveryCodes(session, await redrawProof(stranger)),
    );

    expect(code).toBe('invalid-credentials');
    expect(auth.redrawn).toBe(0);
  });

  it('redraws nothing for an assertion made for another origin', async () => {
    const code = await codeOf(
      service.regenerateRecoveryCodes(session, await redrawProof(holder, 'https://evil.example')),
    );

    expect(code).toBe('invalid-credentials');
    expect(auth.redrawn).toBe(0);
  });

  it('redraws nothing when the ceremony was already spent', async () => {
    const proof = await redrawProof(holder);
    await service.regenerateRecoveryCodes(session, proof);

    expect(await codeOf(service.regenerateRecoveryCodes(session, proof))).toBe('challenge-expired');
    expect(auth.redrawn).toBe(1);
  });
});

describe('list', () => {
  it('blocks removal only for the last passkey of a required account without an app', async () => {
    const key = new SoftwareAuthenticator();
    rows.rows.push(rowFor(userId, 'Only', key.credentialId, key.cosePublicKey));
    auth.required = true;

    const blocked = await service.list(userId, tx);
    auth.user = { ...auth.user, totpEnabled: true } as StaffUser;
    const withApp = await service.list(userId, tx);

    expect(blocked).toMatchObject({
      removalBlocked: true,
      limit: 10,
      state: 'available',
      authenticatorApp: false,
    });
    expect(withApp).toMatchObject({ removalBlocked: false, authenticatorApp: true });
  });
});

describe('installStatus', () => {
  it('counts passkeys and the people holding them, with the pin', async () => {
    pin.pinned = { rpId: 'desk.example.com', pinnedAt: new Date('2026-10-20T08:00:00Z') };
    const first = new SoftwareAuthenticator();
    const second = new SoftwareAuthenticator();
    rows.rows.push(
      rowFor(userId, 'One', first.credentialId, first.cosePublicKey),
      rowFor(uuidv7(), 'Two', second.credentialId, second.cosePublicKey),
    );

    expect(await service.installStatus()).toEqual({
      state: 'available',
      rpId: 'desk.example.com',
      pinnedRpId: 'desk.example.com',
      pinnedAt: '2026-10-20T08:00:00.000Z',
      pinLocked: false,
      passkeyCount: 2,
      holderCount: 2,
      blockers: { breakGlassAccounts: 0, secondFactorAccounts: 0 },
    });
  });

  it('says paused, naming both hosts, when the address moved', async () => {
    pin.pinned = { rpId: 'admin.example.com', pinnedAt: null };

    expect(await service.installStatus()).toMatchObject({
      state: 'paused',
      rpId: 'desk.example.com',
      pinnedRpId: 'admin.example.com',
      pinnedAt: null,
    });
  });

  it('reports a pin the environment holds as locked', async () => {
    pin.locked = true;

    expect(await service.installStatus()).toMatchObject({ pinLocked: true, pinnedRpId: null });
  });
});

describe('moveToCurrentHost', () => {
  const adminId = uuidv7();
  const addFor = (owner: string, name: string) => {
    const key = new SoftwareAuthenticator();
    rows.rows.push(rowFor(owner, name, key.credentialId, key.cosePublicKey));
  };
  const moved = () => {
    pin.pinned = { rpId: 'admin.example.com', pinnedAt: null };
  };

  it('removes every passkey, re-pins, audits and emails each holder once', async () => {
    moved();
    const other = uuidv7();
    addFor(userId, 'A');
    addFor(userId, 'B');
    addFor(other, 'C');
    rows.withApp.add(other);

    const result = await service.moveToCurrentHost(adminId);

    expect(result).toEqual({
      rpId: 'desk.example.com',
      passkeysRemoved: 3,
      holdersNotified: 2,
    });
    expect(rows.rows).toEqual([]);
    expect(pin.pinned?.rpId).toBe('desk.example.com');
    expect(pin.audited).toEqual([
      expect.objectContaining({
        action: 'auth.passkey.rp_moved',
        actorType: 'staff',
        actorId: adminId,
        meta: { from: 'admin.example.com', to: 'desk.example.com', passkeys: 3, holders: 2 },
      }),
    ]);
    expect(auth.notices).toEqual([
      { change: 'passkeysMoved', values: { account: 'desk.example.com', totp: '0' } },
      { change: 'passkeysMoved', values: { account: 'desk.example.com', totp: '1' } },
    ]);
    expect((await service.installStatus()).state).toBe('available');
  });

  it('forgets the recovery codes of a holder whose only second factor was a passkey', async () => {
    moved();
    const other = uuidv7();
    addFor(userId, 'Only');
    addFor(other, 'With app');
    rows.withApp.add(other);

    await service.moveToCurrentHost(adminId);

    expect(auth.clearRecoveryCodes).toHaveBeenCalledTimes(1);
    expect(auth.clearRecoveryCodes).toHaveBeenCalledWith(userId, expect.anything());
  });

  it('refuses when nothing is paused and removes nothing', async () => {
    pin.pinned = { rpId: 'desk.example.com', pinnedAt: new Date() };
    addFor(userId, 'Kept');

    await expect(service.moveToCurrentHost(adminId)).rejects.toMatchObject({
      reason: 'not-paused',
    });
    expect(rows.rows).toHaveLength(1);
    expect(pin.audited).toEqual([]);
  });

  it('refuses when the environment pins the RP ID', async () => {
    moved();
    pin.locked = true;
    addFor(userId, 'Kept');

    await expect(service.moveToCurrentHost(adminId)).rejects.toMatchObject({
      reason: 'pin-locked',
    });
    expect(rows.rows).toHaveLength(1);
    expect(pin.pinned?.rpId).toBe('admin.example.com');
  });

  it('changes nothing, and audits nothing, when a holder cannot be told', async () => {
    moved();
    addFor(userId, 'A');
    addFor(uuidv7(), 'B');
    auth.notifyCredentialChange.mockRejectedValueOnce(new Error('outbox down'));

    await expect(service.moveToCurrentHost(adminId)).rejects.toThrow('outbox down');

    expect(pin.pinned?.rpId).toBe('admin.example.com');
    expect(pin.audited).toEqual([]);
  });

  it('refuses while a configured break-glass account would lose its only factor', async () => {
    moved();
    addFor(userId, 'Only key');
    breakGlassLost = 2;

    await expect(service.moveToCurrentHost(adminId)).rejects.toMatchObject({
      reason: 'move-blocked',
    });
    expect(pin.pinned?.rpId).toBe('admin.example.com');
    expect(pin.audited).toEqual([]);
  });

  it('refuses while an account that must have a second factor would be left with none', async () => {
    moved();
    const withApp = uuidv7();
    addFor(userId, 'Only key');
    addFor(withApp, 'Key');
    rows.withApp.add(withApp);
    auth.requiredIds.add(userId);
    auth.requiredIds.add(withApp);

    await expect(service.moveToCurrentHost(adminId)).rejects.toMatchObject({
      reason: 'move-blocked',
    });
    expect(rows.rows).toHaveLength(2);
  });

  it('is told, by installStatus, what would block it', async () => {
    moved();
    addFor(userId, 'Only key');
    auth.requiredIds.add(userId);
    breakGlassLost = 1;

    expect((await service.installStatus()).blockers).toEqual({
      breakGlassAccounts: 1,
      secondFactorAccounts: 1,
    });
  });

  it('answers a conflict when another move got there first', async () => {
    moved();
    addFor(userId, 'A');
    // The pin changed between the status read and the move: another move won.
    const win = pin.moveTo.bind(pin);
    pin.moveTo = async (move, within) => {
      pin.pinned = { rpId: 'desk.example.com', pinnedAt: new Date() };
      return win(move, within);
    };

    await expect(service.moveToCurrentHost(adminId)).rejects.toMatchObject({
      reason: 'not-paused',
    });
    expect(rows.rows).toHaveLength(1);
  });
});

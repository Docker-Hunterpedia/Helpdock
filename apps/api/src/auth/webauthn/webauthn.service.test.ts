import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@helpdock/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import { MemoryRpIdPin } from '../../testing/memory-rp-id-pin.js';
import { SoftwareAuthenticator } from '../../testing/software-authenticator.js';
import { AuthFailure } from '../auth-failure.js';
import { WebAuthnCeremonyStore } from './ceremony-store.js';
import {
  counterRegressed,
  type StoredPasskey,
  truncateUtf8,
  USER_NAME_MAX_BYTES,
  WebAuthnService,
} from './webauthn.service.js';

const APP_URL = 'https://desk.example.com';
const ORIGIN = 'https://desk.example.com';
const RP_ID = 'desk.example.com';

const userId = uuidv7();
const familyId = uuidv7();
const binding = { userId, familyId };
const user = { handle: new Uint8Array(randomBytes(32)), email: 'lina@example.com', name: 'Lina' };

let pin: MemoryRpIdPin;
let ceremonies: WebAuthnCeremonyStore;
let service: WebAuthnService;

const serviceAt = (appUrl: string): WebAuthnService =>
  new WebAuthnService({ appUrl, ceremonies, pin });

beforeEach(() => {
  pin = new MemoryRpIdPin();
  ceremonies = new WebAuthnCeremonyStore(authRedis().redis);
  service = serviceAt(APP_URL);
});

const authCode = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AuthFailure ? error.auth.code : `not an AuthFailure: ${error}`;
  }
};

/** Registers `authenticator` the way M18-02's routes will, and returns the row they would store. */
const register = async (authenticator: SoftwareAuthenticator): Promise<StoredPasskey> => {
  const { ceremonyId, options } = await service.registrationOptions({
    user,
    existing: [],
    binding,
  });
  const registered = await service.verifyRegistration({
    ceremonyId,
    binding,
    response: authenticator.register(options, { origin: ORIGIN }),
  });
  return { ...registered, userId };
};

const finder =
  (...stored: StoredPasskey[]) =>
  (credentialId: Uint8Array): Promise<StoredPasskey | undefined> =>
    Promise.resolve(
      stored.find((row) => Buffer.from(row.credentialId).equals(Buffer.from(credentialId))),
    );

describe('registrationOptions', () => {
  it('names this install as the relying party, from APP_URL', async () => {
    const { options } = await service.registrationOptions({ user, existing: [], binding });

    expect(options.rp).toEqual({ id: RP_ID, name: 'Helpdock' });
  });

  it('offers EdDSA, ES256 and RS256 only, and asks for no attestation', async () => {
    const { options } = await service.registrationOptions({ user, existing: [], binding });

    expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-8, -7, -257]);
    expect(options.attestation).toBe('none');
  });

  it('prefers a discoverable credential and asks the browser whether it made one', async () => {
    const { options } = await service.registrationOptions({ user, existing: [], binding });

    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'preferred',
      userVerification: 'preferred',
    });
    expect(options.extensions).toMatchObject({ credProps: true });
  });

  it("uses the account's random handle as the user id, never its account id", async () => {
    const { options } = await service.registrationOptions({ user, existing: [], binding });

    expect(options.user.id).toBe(Buffer.from(user.handle).toString('base64url'));
    expect(options.user.id).not.toContain(userId);
  });

  it('lists the passkeys the account already has, so one key is not added twice', async () => {
    const existing = { credentialId: new Uint8Array([1, 2, 3]), transports: ['usb', 'bogus'] };

    const { options } = await service.registrationOptions({ user, existing: [existing], binding });

    expect(options.excludeCredentials).toEqual([
      { id: 'AQID', type: 'public-key', transports: ['usb'] },
    ]);
  });

  it('cuts a long Arabic name on a letter, not through one', async () => {
    const name = 'لينا حداد من فريق الفوترة والمدفوعات في المكتب الإقليمي';

    const { options } = await service.registrationOptions({
      user: { ...user, name },
      existing: [],
      binding,
    });

    expect(Buffer.byteLength(options.user.displayName, 'utf8')).toBeLessThanOrEqual(
      USER_NAME_MAX_BYTES,
    );
    expect(name.startsWith(options.user.displayName)).toBe(true);
  });
});

describe('truncateUtf8', () => {
  it('keeps a string that fits', () => {
    expect(truncateUtf8('Lina', 64)).toBe('Lina');
  });

  it('never splits a code point', () => {
    // Each Arabic letter is two bytes; five bytes hold two of them.
    expect(truncateUtf8('لينا', 5)).toBe('لي');
    // An emoji outside the BMP is four bytes and two UTF-16 units.
    expect(truncateUtf8('a😀b', 4)).toBe('a');
  });
});

describe('authenticationOptions', () => {
  it('requires user verification for passwordless sign-in and break-glass', async () => {
    for (const purpose of ['passwordless', 'break-glass'] as const) {
      const { options } = await service.authenticationOptions({ purpose });
      expect(options.userVerification, purpose).toBe('required');
    }
  });

  it('accepts user presence alone after another factor', async () => {
    for (const purpose of ['second-factor', 'step-up'] as const) {
      const { options } = await service.authenticationOptions({ purpose, binding: { userId } });
      expect(options.userVerification, purpose).toBe('preferred');
    }
  });

  it('names no credentials unless the caller lists them', async () => {
    const { options } = await service.authenticationOptions({ purpose: 'passwordless' });

    expect(options.allowCredentials).toBeUndefined();
    expect(options.rpId).toBe(RP_ID);
  });
});

describe('a registration', () => {
  it('verifies and hands back what is to be stored', async () => {
    const authenticator = new SoftwareAuthenticator({ backupEligible: true, backedUp: true });

    const stored = await register(authenticator);

    expect(stored).toMatchObject({
      algorithm: -7,
      signCount: 0,
      transports: ['internal'],
      aaguid: null,
      discoverable: true,
      backupEligible: true,
      backedUp: true,
      userVerified: true,
    });
    expect(Buffer.from(stored.credentialId).equals(Buffer.from(authenticator.credentialId))).toBe(
      true,
    );
  });

  it('refuses an answer made for another origin', async () => {
    const { ceremonyId, options } = await service.registrationOptions({
      user,
      existing: [],
      binding,
    });
    const response = new SoftwareAuthenticator().register(options, {
      origin: 'https://desk.example.com.evil.test',
    });

    expect(await authCode(service.verifyRegistration({ ceremonyId, binding, response }))).toBe(
      'invalid-credentials',
    );
  });

  it('refuses an answer for a ceremony begun in another browser session', async () => {
    const { ceremonyId, options } = await service.registrationOptions({
      user,
      existing: [],
      binding,
    });
    const response = new SoftwareAuthenticator().register(options, { origin: ORIGIN });

    expect(
      await authCode(
        service.verifyRegistration({
          ceremonyId,
          binding: { userId, familyId: uuidv7() },
          response,
        }),
      ),
    ).toBe('challenge-expired');
  });

  it('refuses a malformed attestation without throwing anything else', async () => {
    const { ceremonyId, options } = await service.registrationOptions({
      user,
      existing: [],
      binding,
    });
    const response = new SoftwareAuthenticator().register(options, { origin: ORIGIN });

    const garbled = {
      ...response,
      response: { ...response.response, attestationObject: 'not-cbor' },
    };

    expect(
      await authCode(service.verifyRegistration({ ceremonyId, binding, response: garbled })),
    ).toBe('invalid-credentials');
  });
});

describe('an assertion', () => {
  let authenticator: SoftwareAuthenticator;
  let stored: StoredPasskey;

  beforeEach(async () => {
    authenticator = new SoftwareAuthenticator();
    stored = await register(authenticator);
  });

  const assertFor = async (
    purpose: 'passwordless' | 'second-factor',
    overrides: Parameters<SoftwareAuthenticator['assert']>[1] = { origin: ORIGIN },
  ) => {
    const ceremonyBinding = purpose === 'passwordless' ? {} : { userId };
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose,
      binding: ceremonyBinding,
    });
    return service.verifyAuthentication({
      ceremonyId,
      purpose,
      binding: ceremonyBinding,
      response: authenticator.assert(options, overrides),
      findCredential: finder(stored),
    });
  };

  it('verifies a passwordless sign-in with user verification', async () => {
    await expect(assertFor('passwordless')).resolves.toMatchObject({
      ok: true,
      newSignCount: 0,
      userVerified: true,
      credential: { userId },
    });
  });

  it('refuses a passwordless sign-in without user verification', async () => {
    await expect(
      assertFor('passwordless', { origin: ORIGIN, userVerified: false }),
    ).resolves.toEqual({ ok: false, reason: 'bad-assertion', userId });
  });

  it('accepts user presence alone as a second factor', async () => {
    await expect(
      assertFor('second-factor', { origin: ORIGIN, userVerified: false }),
    ).resolves.toMatchObject({ ok: true, userVerified: false });
  });

  it('refuses an assertion signed for another origin', async () => {
    await expect(
      assertFor('passwordless', { origin: 'https://desk-example.com' }),
    ).resolves.toMatchObject({ ok: false, reason: 'bad-assertion' });
  });

  it('refuses an assertion made for another RP ID', async () => {
    await expect(
      assertFor('passwordless', { origin: ORIGIN, rpId: 'example.com' }),
    ).resolves.toMatchObject({ ok: false, reason: 'bad-assertion' });
  });

  it('refuses a credential this install does not hold', async () => {
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose: 'passwordless',
    });

    await expect(
      service.verifyAuthentication({
        ceremonyId,
        purpose: 'passwordless',
        response: new SoftwareAuthenticator().assert(options, { origin: ORIGIN }),
        findCredential: finder(stored),
      }),
    ).resolves.toEqual({ ok: false, reason: 'unknown-credential', userId: null });
  });

  it("refuses another person's passkey on a second-factor prompt", async () => {
    const someoneElse = uuidv7();
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose: 'second-factor',
      binding: { userId: someoneElse },
    });

    await expect(
      service.verifyAuthentication({
        ceremonyId,
        purpose: 'second-factor',
        binding: { userId: someoneElse },
        response: authenticator.assert(options, { origin: ORIGIN }),
        findCredential: finder(stored),
      }),
    ).resolves.toEqual({ ok: false, reason: 'wrong-user', userId: someoneElse });
  });

  it('refuses a counter that went backwards, once the signature checks out', async () => {
    stored = { ...stored, signCount: 7 };

    await expect(assertFor('passwordless', { origin: ORIGIN, signCount: 7 })).resolves.toEqual({
      ok: false,
      reason: 'counter-regressed',
      userId,
    });
  });

  it('accepts a counter that moved forward and reports it', async () => {
    stored = { ...stored, signCount: 7 };

    await expect(
      assertFor('passwordless', { origin: ORIGIN, signCount: 8 }),
    ).resolves.toMatchObject({ ok: true, newSignCount: 8 });
  });

  it('cannot be replayed: the ceremony is spent by the first answer', async () => {
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose: 'passwordless',
    });
    const response = authenticator.assert(options, { origin: ORIGIN });
    const check = () =>
      service.verifyAuthentication({
        ceremonyId,
        purpose: 'passwordless',
        response,
        findCredential: finder(stored),
      });

    await expect(check()).resolves.toMatchObject({ ok: true });
    expect(await authCode(check())).toBe('challenge-expired');
  });

  it('cannot finish a ceremony of another purpose', async () => {
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose: 'step-up',
      binding: { userId },
    });

    expect(
      await authCode(
        service.verifyAuthentication({
          ceremonyId,
          purpose: 'break-glass',
          binding: { userId },
          response: authenticator.assert(options, { origin: ORIGIN }),
          findCredential: finder(stored),
        }),
      ),
    ).toBe('challenge-expired');
  });

  it.each([
    ['an empty rawId', { rawId: '' }],
    ['a rawId over 1,023 bytes', { rawId: Buffer.alloc(1_024).toString('base64url') }],
  ])('treats %s as an unknown credential', async (_case, patch) => {
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose: 'passwordless',
    });

    await expect(
      service.verifyAuthentication({
        ceremonyId,
        purpose: 'passwordless',
        response: { ...authenticator.assert(options, { origin: ORIGIN }), ...patch },
        findCredential: finder(stored),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'unknown-credential' });
  });

  it.each([
    ['authenticator data that is too short', { authenticatorData: 'AAAA' }],
    ['client data that is not JSON', { clientDataJSON: Buffer.from('{').toString('base64url') }],
    ['a signature that is not DER', { signature: 'AAAA' }],
  ])('refuses %s', async (_case, patch) => {
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose: 'passwordless',
    });
    const response = authenticator.assert(options, { origin: ORIGIN });

    await expect(
      service.verifyAuthentication({
        ceremonyId,
        purpose: 'passwordless',
        response: { ...response, response: { ...response.response, ...patch } },
        findCredential: finder(stored),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'bad-assertion' });
  });
});

describe('counterRegressed', () => {
  it.each([
    [0, 0, false],
    [0, 3, false],
    [3, 4, false],
    [3, 3, true],
    [3, 0, true],
    [3, 2, true],
  ])('stored %i, presented %i: %s', (stored, presented, regressed) => {
    expect(counterRegressed(stored, presented)).toBe(regressed);
  });
});

describe('the RP ID pin', () => {
  it('pins the RP ID at the first ceremony', async () => {
    expect(pin.pinned).toBeNull();

    await service.authenticationOptions({ purpose: 'passwordless' });

    expect(pin.pinned?.rpId).toBe(RP_ID);
  });

  it('reports passkeys as available on the pinned host', async () => {
    pin = new MemoryRpIdPin(RP_ID);

    await expect(serviceAt(APP_URL).status()).resolves.toMatchObject({
      state: 'available',
      rpId: RP_ID,
    });
  });

  it('pauses passkeys when APP_URL has moved to another host', async () => {
    pin = new MemoryRpIdPin('admin.example.com');
    const moved = serviceAt(APP_URL);

    await expect(moved.status()).resolves.toMatchObject({
      state: 'paused',
      rpId: RP_ID,
      pinned: { rpId: 'admin.example.com' },
    });
    expect(await authCode(moved.authenticationOptions({ purpose: 'passwordless' }))).toBe(
      'passkeys-rp-changed',
    );
    expect(await authCode(moved.registrationOptions({ user, existing: [], binding }))).toBe(
      'passkeys-rp-changed',
    );
  });

  it('refuses to finish a ceremony begun before the pin changed', async () => {
    const { ceremonyId, options } = await service.authenticationOptions({
      purpose: 'passwordless',
    });
    const response = new SoftwareAuthenticator().assert(options, { origin: ORIGIN });
    pin.pinned = { rpId: 'admin.example.com', pinnedAt: new Date() };

    expect(
      await authCode(
        service.verifyAuthentication({
          ceremonyId,
          purpose: 'passwordless',
          response,
          findCredential: finder(),
        }),
      ),
    ).toBe('passkeys-rp-changed');
  });

  it('has no passkeys on a plain-http install, and pins nothing', async () => {
    const insecure = serviceAt('http://desk.example.com');

    await expect(insecure.status()).resolves.toEqual({ state: 'unavailable' });
    expect(await authCode(insecure.authenticationOptions({ purpose: 'passwordless' }))).toBe(
      'passkeys-unavailable',
    );
    expect(pin.pinned).toBeNull();
  });
});

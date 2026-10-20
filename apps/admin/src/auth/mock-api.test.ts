import { describe, expect, it } from 'vitest';
import type { AuthError } from './api.js';
import {
  MOCK_EMAIL,
  MOCK_PASSWORD,
  MOCK_RECOVERY_CODE,
  MOCK_TOTP_CODE,
  MockAuthApi,
} from './mock-api.js';

const startChallenge = async (api: MockAuthApi): Promise<string> => {
  const result = await api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD);
  if (result.kind !== 'totp-required') {
    throw new Error('expected a second factor to be required');
  }

  return result.challengeId;
};

describe('MockAuthApi', () => {
  it('asks for a second factor after a correct password', async () => {
    const api = new MockAuthApi();

    await expect(api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD)).resolves.toMatchObject({
      kind: 'totp-required',
      email: MOCK_EMAIL,
    });
  });

  it('accepts the address in any case and with surrounding space', async () => {
    const api = new MockAuthApi();

    await expect(
      api.signInWithPassword(`  ${MOCK_EMAIL.toUpperCase()} `, MOCK_PASSWORD),
    ).resolves.toMatchObject({ kind: 'totp-required' });
  });

  it.each([
    ['a wrong password', MOCK_EMAIL, 'wrong horse'],
    ['an unknown address', 'nobody@helpdock.com', MOCK_PASSWORD],
  ])('rejects %s without saying which half was wrong', async (_case, email, password) => {
    const api = new MockAuthApi();

    await expect(api.signInWithPassword(email, password)).rejects.toMatchObject({
      code: 'invalid-credentials',
    });
  });

  it('returns the session once the code matches, and remembers it', async () => {
    const api = new MockAuthApi();
    const challengeId = await startChallenge(api);

    const session = await api.verifyTotp(challengeId, MOCK_TOTP_CODE, { trustDevice: false });

    expect(session.user.email).toBe(MOCK_EMAIL);
    await expect(api.me()).resolves.toBe(session);
  });

  it('locks the challenge on the third wrong code and counts down before that', async () => {
    const api = new MockAuthApi();
    const challengeId = await startChallenge(api);
    const codes: AuthError[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api
        .verifyTotp(challengeId, '000000', { trustDevice: false })
        .catch((error: AuthError) => {
          codes.push(error);
        });
    }

    expect(codes.map((error) => [error.code, error.attemptsLeft])).toEqual([
      ['totp-mismatch', 2],
      ['totp-mismatch', 1],
      ['totp-locked', undefined],
    ]);
  });

  it('keeps refusing a locked challenge even when the code is right', async () => {
    const api = new MockAuthApi();
    const challengeId = await startChallenge(api);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api.verifyTotp(challengeId, '000000', { trustDevice: false }).catch(() => undefined);
    }

    await expect(
      api.verifyTotp(challengeId, MOCK_TOTP_CODE, { trustDevice: false }),
    ).rejects.toMatchObject({ code: 'totp-locked' });
  });

  it('spends the same attempt budget on recovery codes, so a lock cannot be dodged', async () => {
    const api = new MockAuthApi();
    const challengeId = await startChallenge(api);

    await api.useRecoveryCode(challengeId, 'RC-0000-0000').catch(() => undefined);

    await expect(
      api.verifyTotp(challengeId, '000000', { trustDevice: false }),
    ).rejects.toMatchObject({ code: 'totp-mismatch', attemptsLeft: 1 });
  });

  it('signs in with a recovery code once, then refuses it', async () => {
    const api = new MockAuthApi();

    const first = await startChallenge(api);
    await expect(api.useRecoveryCode(first, MOCK_RECOVERY_CODE)).resolves.toMatchObject({
      user: { email: MOCK_EMAIL },
    });

    await api.signOut();
    const second = await startChallenge(api);
    await expect(api.useRecoveryCode(second, MOCK_RECOVERY_CODE)).rejects.toMatchObject({
      code: 'recovery-invalid',
    });
  });

  it('skips the second factor on a browser the user trusted', async () => {
    const api = new MockAuthApi();
    const challengeId = await startChallenge(api);
    await api.verifyTotp(challengeId, MOCK_TOTP_CODE, { trustDevice: true });
    await api.signOut();

    await expect(api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD)).resolves.toMatchObject({
      kind: 'session',
    });
  });

  it('forgets the session on sign out', async () => {
    const api = new MockAuthApi();
    const challengeId = await startChallenge(api);
    await api.verifyTotp(challengeId, MOCK_TOTP_CODE, { trustDevice: false });

    await api.signOut();

    await expect(api.me()).resolves.toBeNull();
  });

  it('rejects a challenge id it never issued', async () => {
    const api = new MockAuthApi();

    await expect(
      api.verifyTotp('nope', MOCK_TOTP_CODE, { trustDevice: false }),
    ).rejects.toMatchObject({ code: 'challenge-expired' });
  });

  it('answers the magic link the same way for any address', async () => {
    const api = new MockAuthApi();

    await expect(api.requestMagicLink('stranger@example.com')).resolves.toBeUndefined();
    await expect(api.me()).resolves.toBeNull();
  });

  it('points the provider buttons at the app callback', () => {
    expect(new MockAuthApi().oauthStartUrl('github')).toBe('/oauth/callback?provider=github');
  });

  it('connects a provider behind a step-up and lands back on the security page', async () => {
    const api = new MockAuthApi();

    await expect(api.connectOauth('github', { currentPassword: 'wrong' })).rejects.toMatchObject({
      code: 'invalid-credentials',
    });
    const landing = await api.connectOauth('github', { code: MOCK_TOTP_CODE });

    expect(landing).toBe('/me/security?connected=github');
    expect((await api.oauthIdentities()).identities.map((row) => row.provider)).toEqual(['github']);
  });

  it('keeps the last way in of an account with no password', async () => {
    const api = new MockAuthApi();
    await api.connectOauth('google', { currentPassword: MOCK_PASSWORD });
    api.passwordSet = false;

    await expect(api.disconnectOauth('google', { code: MOCK_TOTP_CODE })).rejects.toMatchObject({
      code: 'oauth-last-sign-in',
    });
    expect((await api.oauthIdentities()).identities).toHaveLength(1);
  });
});

describe('MockAuthApi passkeys (M18-02)', () => {
  const response = (id: string) => ({
    id,
    rawId: id,
    type: 'public-key' as const,
    response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
    clientExtensionResults: {},
  });

  const add = async (api: MockAuthApi, name: string, id = name) => {
    const { ceremonyId } = await api.beginPasskey({ currentPassword: MOCK_PASSWORD });
    return api.finishPasskey({ ceremonyId, response: response(id), name });
  };

  it('adds behind a proof and lists the result', async () => {
    const api = new MockAuthApi();

    await add(api, 'Laptop');

    expect((await api.passkeys()).passkeys.map((entry) => entry.name)).toEqual(['Laptop']);
  });

  it('spends a ceremony once', async () => {
    const api = new MockAuthApi();
    const { ceremonyId } = await api.beginPasskey({ currentPassword: MOCK_PASSWORD });
    await api.finishPasskey({ ceremonyId, response: response('a'), name: 'One' });

    await expect(
      api.finishPasskey({ ceremonyId, response: response('b'), name: 'Two' }),
    ).rejects.toMatchObject({ code: 'challenge-expired' });
  });

  it('refuses a wrong proof, and locks after five', async () => {
    const api = new MockAuthApi();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(api.beginPasskey({ currentPassword: 'wrong' })).rejects.toMatchObject({
        code: 'invalid-credentials',
      });
    }

    await expect(api.beginPasskey({ currentPassword: MOCK_PASSWORD })).rejects.toMatchObject({
      code: 'totp-locked',
    });
  });

  it('refuses the eleventh passkey', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ count: 10 });

    await expect(api.beginPasskey({ currentPassword: MOCK_PASSWORD })).rejects.toMatchObject({
      code: 'passkey-limit',
    });
  });

  it('refuses to remove the only second factor of an account that needs one', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ count: 1, onlyFactor: true });
    const [only] = (await api.passkeys()).passkeys;

    await expect(
      api.removePasskey(only?.id ?? '', { currentPassword: MOCK_PASSWORD }),
    ).rejects.toMatchObject({ code: 'second-factor-required' });
    expect((await api.passkeys()).removalBlocked).toBe(true);
  });

  it('renames and removes, and answers an unknown id as missing', async () => {
    const api = new MockAuthApi();
    const added = await add(api, 'Old');

    const renamed = await api.renamePasskey(added.id, 'New', { code: MOCK_TOTP_CODE });
    await api.removePasskey(added.id, { code: MOCK_TOTP_CODE });

    expect(renamed.name).toBe('New');
    expect((await api.passkeys()).passkeys).toEqual([]);
    await expect(api.removePasskey(added.id, { code: MOCK_TOTP_CODE })).rejects.toMatchObject({
      code: 'no-account',
    });
  });

  it('offers the step-up only for passkeys an authenticator made, and accepts it once', async () => {
    const api = new MockAuthApi();
    await expect(api.passkeyStepUpOptions()).rejects.toMatchObject({ code: 'invalid-credentials' });
    const added = await add(api, 'Laptop', 'AQID');
    const { ceremonyId, options } = await api.passkeyStepUpOptions();
    const proof = {
      passkey: {
        ceremonyId,
        response: {
          id: 'AQID',
          rawId: 'AQID',
          type: 'public-key' as const,
          response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
          clientExtensionResults: {},
        },
      },
    };

    expect(options).toMatchObject({ allowCredentials: [{ id: 'AQID' }] });
    await api.renamePasskey(added.id, 'Renamed', proof);
    await expect(api.renamePasskey(added.id, 'Again', proof)).rejects.toMatchObject({
      code: 'challenge-expired',
    });
  });
});

describe('MockAuthApi passkey as the second factor (M18-03)', () => {
  const answer = (id = 'AQID') => ({
    ceremonyId: 'unset',
    response: {
      id,
      rawId: id,
      type: 'public-key' as const,
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: {},
    },
  });
  const created = (id = 'AQID') => ({
    id,
    rawId: id,
    type: 'public-key' as const,
    response: { clientDataJSON: 'e30', attestationObject: 'o2NmbXRkbm9uZQ' },
    clientExtensionResults: {},
  });

  it('names the factors of the account in the challenge', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ count: 1 });

    await expect(api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD)).resolves.toMatchObject({
      factors: { totp: true, passkey: true },
    });
  });

  it('signs in with a passkey for a ceremony it issued, once', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ count: 1 });
    const challengeId = await startChallenge(api);
    const { ceremonyId } = await api.passkeySecondFactorOptions(challengeId);

    await expect(
      api.verifyPasskey(challengeId, { ...answer(), ceremonyId }, { trustDevice: false }),
    ).resolves.toMatchObject({ user: { email: MOCK_EMAIL } });
    await expect(
      api.verifyPasskey(challengeId, { ...answer(), ceremonyId }, { trustDevice: false }),
    ).rejects.toMatchObject({ code: 'challenge-expired' });
  });

  it('counts a ceremony it never issued against the same three attempts as a code', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ count: 1 });
    const challengeId = await startChallenge(api);
    const codes: (string | undefined)[] = [];

    await api
      .verifyTotp(challengeId, '000000', { trustDevice: false })
      .catch((error: AuthError) => {
        codes.push(error.code);
      });
    await api
      .verifyPasskey(challengeId, answer(), { trustDevice: false })
      .catch((error: AuthError) => {
        codes.push(`${error.code}:${error.attemptsLeft}`);
      });
    await api.useRecoveryCode(challengeId, 'nope').catch((error: AuthError) => {
      codes.push(error.code);
    });

    expect(codes).toEqual(['totp-mismatch', 'passkey-invalid:1', 'totp-locked']);
  });

  it('sends an account that must have a second factor to the chooser, once, and enrols a passkey', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ enrol: true });
    const started = await api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD);
    if (started.kind !== 'second-factor-enrolment-required') throw new Error('expected enrolment');

    const { ceremonyId } = await api.startPasskeyEnrolment(started.challengeId);
    const done = await api.completePasskeyEnrolment(started.challengeId, {
      response: created('cred-1'),
      ceremonyId,
      name: 'Laptop',
    });

    expect(done.recoveryCodes).toHaveLength(10);
    expect((await api.passkeys()).passkeys.map((entry) => entry.name)).toEqual(['Laptop']);
    await api.signOut();
    await expect(api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD)).resolves.toMatchObject({
      kind: 'totp-required',
      factors: { passkey: true },
    });
  });

  it('refuses an enrolment answer for a ceremony it never issued', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ enrol: true });
    const started = await api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD);
    if (started.kind !== 'second-factor-enrolment-required') throw new Error('expected enrolment');

    await expect(
      api.completePasskeyEnrolment(started.challengeId, {
        ceremonyId: 'unset',
        response: created(),
        name: 'Laptop',
      }),
    ).rejects.toMatchObject({ code: 'passkey-invalid' });
  });

  it('draws recovery codes with a first passkey only', async () => {
    const api = new MockAuthApi();
    api.seedPasskeys({ onlyFactor: true });
    const first = await api.beginPasskey({ currentPassword: MOCK_PASSWORD });
    const added = await api.finishPasskey({
      ceremonyId: first.ceremonyId,
      response: answer('a').response as never,
      name: 'One',
    });
    const second = await api.beginPasskey({ currentPassword: MOCK_PASSWORD });
    const next = await api.finishPasskey({
      ceremonyId: second.ceremonyId,
      response: answer('b').response as never,
      name: 'Two',
    });

    expect(added.recoveryCodes).toHaveLength(10);
    expect(next.recoveryCodes).toBeUndefined();
  });
});

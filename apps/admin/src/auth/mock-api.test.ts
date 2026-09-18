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
});

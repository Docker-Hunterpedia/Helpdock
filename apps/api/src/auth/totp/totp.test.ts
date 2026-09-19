import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { newTotpSecret, TOTP_PERIOD_SECONDS, totpUri, verifyTotpCode } from './totp.js';

/** A fixed point in time, so "one step ago" is a number and not a race. */
const NOW = 1_700_000_000;

const codeAt = (secret: string, epochSeconds: number): Promise<string> =>
  generate({ secret, period: TOTP_PERIOD_SECONDS, epoch: epochSeconds });

describe('newTotpSecret', () => {
  it('is base32, which is what an authenticator app can scan and a person can type', () => {
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]+$/);
  });

  it('is different every time', () => {
    expect(newTotpSecret()).not.toBe(newTotpSecret());
  });
});

describe('verifyTotpCode', () => {
  it('accepts the code for right now', async () => {
    const secret = newTotpSecret();

    await expect(
      verifyTotpCode({ secret, code: await codeAt(secret, NOW), epochSeconds: NOW }),
    ).resolves.toBe(true);
  });

  it.each([
    ['one step in the past', -TOTP_PERIOD_SECONDS],
    ['one step in the future', TOTP_PERIOD_SECONDS],
  ])('accepts the code from %s, which is the window of one', async (_case, offset) => {
    const secret = newTotpSecret();

    await expect(
      verifyTotpCode({ secret, code: await codeAt(secret, NOW + offset), epochSeconds: NOW }),
    ).resolves.toBe(true);
  });

  it.each([
    ['two steps in the past', -2 * TOTP_PERIOD_SECONDS],
    ['two steps in the future', 2 * TOTP_PERIOD_SECONDS],
  ])('refuses the code from %s: the window is one step, not two', async (_case, offset) => {
    const secret = newTotpSecret();

    await expect(
      verifyTotpCode({ secret, code: await codeAt(secret, NOW + offset), epochSeconds: NOW }),
    ).resolves.toBe(false);
  });

  it('refuses a code made with another secret', async () => {
    await expect(
      verifyTotpCode({
        secret: newTotpSecret(),
        code: await codeAt(newTotpSecret(), NOW),
        epochSeconds: NOW,
      }),
    ).resolves.toBe(false);
  });

  it.each(['', '000', 'abcdef', '0000000'])('refuses %o without throwing', async (code) => {
    await expect(
      verifyTotpCode({ secret: newTotpSecret(), code, epochSeconds: NOW }),
    ).resolves.toBe(false);
  });
});

describe('totpUri', () => {
  it('names the install and the address, which is what the app shows in its list', () => {
    const uri = totpUri({
      secret: 'JBSWY3DPEHPK3PXP',
      email: 'lina@helpdock.com',
      issuer: 'support.example.com',
    });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=support.example.com');
    expect(decodeURIComponent(uri)).toContain('lina@helpdock.com');
  });
});

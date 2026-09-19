import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PasswordHasher } from '../password.js';
import {
  hashRecoveryCodes,
  newRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  spendRecoveryCode,
} from './recovery-codes.js';

const hasher = new PasswordHasher(randomBytes(32));

describe('newRecoveryCodes', () => {
  it('hands out ten, which is what enrolment promises', () => {
    expect(newRecoveryCodes()).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it('shapes them so they can be read aloud and written down', () => {
    for (const code of newRecoveryCodes()) {
      expect(code).toMatch(/^RC-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    }
  });

  it('never repeats one inside a set', () => {
    const codes = newRecoveryCodes(RECOVERY_CODE_COUNT);

    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('normalizeRecoveryCode', () => {
  it.each([['  rc-4kq2-9xmt '], ['RC-4KQ2-9XMT'], ['rc- 4kq2 -9xmt']])(
    'reads %o as the same code',
    (typed) => {
      expect(normalizeRecoveryCode(typed)).toBe('RC-4KQ2-9XMT');
    },
  );
});

describe('spendRecoveryCode', () => {
  it('matches a code and removes exactly the one that was used', async () => {
    const codes = newRecoveryCodes(3);
    const hashes = await hashRecoveryCodes(codes, hasher);

    const match = await spendRecoveryCode(codes[1] ?? '', hashes, hasher);

    expect(match?.remaining).toHaveLength(2);
    expect(match?.remaining).not.toContain(hashes[1]);
    expect(match?.remaining).toEqual([hashes[0], hashes[2]]);
  });

  it('accepts a code typed in lower case with spaces around it', async () => {
    const codes = newRecoveryCodes(2);
    const hashes = await hashRecoveryCodes(codes, hasher);

    await expect(
      spendRecoveryCode(`  ${(codes[0] ?? '').toLowerCase()} `, hashes, hasher),
    ).resolves.toMatchObject({ remaining: [hashes[1]] });
  });

  it('refuses a code that was already spent', async () => {
    const codes = newRecoveryCodes(2);
    const hashes = await hashRecoveryCodes(codes, hasher);
    const match = await spendRecoveryCode(codes[0] ?? '', hashes, hasher);

    await expect(
      spendRecoveryCode(codes[0] ?? '', match?.remaining ?? [], hasher),
    ).resolves.toBeNull();
  });

  it('refuses a code that was never issued', async () => {
    const hashes = await hashRecoveryCodes(newRecoveryCodes(2), hasher);

    await expect(spendRecoveryCode('RC-0000-0000', hashes, hasher)).resolves.toBeNull();
  });

  it('refuses everything once the list is empty', async () => {
    await expect(spendRecoveryCode('RC-0000-0000', [], hasher)).resolves.toBeNull();
  });

  it('stores hashes, never the codes themselves', async () => {
    const codes = newRecoveryCodes(2);
    const hashes = await hashRecoveryCodes(codes, hasher);

    for (const [index, hash] of hashes.entries()) {
      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(hash).not.toContain(codes[index] ?? '');
    }
  });
});

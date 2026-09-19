import { randomInt } from 'node:crypto';
import type { PasswordHasher } from '../password.js';

/**
 * The ten codes handed out at enrolment, for the day the phone is gone.
 *
 * Each is single use and each is stored as an argon2 hash under the same pepper
 * as a password — a recovery code *is* a password, and a leaked database must
 * not be a set of second factors. Checking one therefore costs ten argon2
 * verifications at worst, which is affordable because a challenge allows three
 * attempts in total (DOMAIN-RULES §1.4) and nothing else ever calls this.
 */

export const RECOVERY_CODE_COUNT = 10;
/** Two groups of four, which is short enough to read aloud and write down. */
const GROUP_LENGTH = 4;
/**
 * Crockford's base32 without `I`, `L`, `O` and `U`: no character can be
 * confused with another on paper, and none of them spell anything.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const group = (): string =>
  Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/** `RC-4KQ2-9XMT`. The prefix is what makes one recognisable in a password manager. */
export const newRecoveryCode = (): string => `RC-${group()}-${group()}`;

/** Upper-cased and stripped of spaces, so a code typed from paper still matches. */
export const normalizeRecoveryCode = (code: string): string =>
  code.trim().toUpperCase().replaceAll(/\s+/g, '');

export const newRecoveryCodes = (count = RECOVERY_CODE_COUNT): string[] =>
  Array.from({ length: count }, newRecoveryCode);

export const hashRecoveryCodes = async (
  codes: readonly string[],
  hasher: PasswordHasher,
): Promise<string[]> => Promise.all(codes.map((code) => hasher.hash(normalizeRecoveryCode(code))));

export interface RecoveryCodeMatch {
  /** The remaining hashes, with the spent one removed. Store them. */
  readonly remaining: string[];
}

/**
 * Spends a code, or answers `null`. Every stored hash is tried even after a
 * match, so the time a wrong code takes does not depend on how many codes are
 * left or on where in the list the right one sits.
 *
 * One at a time, not all at once: each argon2 verification claims 19 MiB while
 * it runs, and ten of them in parallel would make a single request a 190 MiB
 * spike that concurrent requests multiply.
 */
export const spendRecoveryCode = async (
  code: string,
  hashes: readonly string[],
  hasher: PasswordHasher,
): Promise<RecoveryCodeMatch | null> => {
  const candidate = normalizeRecoveryCode(code);
  let index = -1;

  for (const [position, hash] of hashes.entries()) {
    if ((await hasher.verify(hash, candidate)).valid) {
      index = position;
    }
  }

  if (index === -1) {
    return null;
  }

  return { remaining: hashes.filter((_, position) => position !== index) };
};

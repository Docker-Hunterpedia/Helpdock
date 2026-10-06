import { hkdfSync, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Argon2id with a pepper, as REQUIREMENTS §5.1 and ARCHITECTURE §7 ask for.
 *
 * The **pepper** is derived from `APP_MASTER_KEY` with HKDF and handed to
 * argon2 as its `secret`. It is never stored, so a stolen database is not a set
 * of crackable hashes: without the master key from `.env`, no candidate
 * password can even be tested. It is derived rather than used directly so that
 * the same master key can key other things (the trusted-device cookie does)
 * without any two of them sharing key material.
 *
 * During a master key rotation (DOMAIN-RULES §10) a hash may still be under
 * the pepper of `APP_MASTER_KEY_PREVIOUS`. Rotation cannot re-pepper it, because
 * that needs the password, so a hash the previous pepper verifies is reported
 * as needing a rehash and is replaced at that sign-in.
 *
 * The **parameters** are the current OWASP minimum for Argon2id — 19 MiB of
 * memory, two passes, one lane. A hash that was made with anything weaker, or
 * by an older version of this code, is replaced on the next successful sign-in,
 * which is the only moment the plaintext is in hand.
 */

/** OWASP Password Storage Cheat Sheet, Argon2id: m=19456 KiB, t=2, p=1. */
export const ARGON2_PARAMETERS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

const PEPPER_BYTES = 32;
const PEPPER_INFO = 'helpdock:auth:password-pepper';

/**
 * HKDF-SHA256 over the master key. The salt is empty on purpose: HKDF's
 * extract step is defined for an empty salt, the input is already 32 bytes of
 * uniform key material, and a stored salt would be one more thing that must
 * survive a restore for the hashes to stay verifiable.
 */
export const derivePepper = (masterKey: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), PEPPER_INFO, PEPPER_BYTES));

/**
 * `argon2.verify` compares in constant time and answers false for a wrong
 * password or a wrong pepper. It *throws* for a digest that is not a PHC string
 * at all, which a row written by something other than this code could be; that
 * is a refusal like any other, not a 500.
 */
const verifyWith = async (digest: string, password: string, pepper: Buffer): Promise<boolean> => {
  try {
    return await argon2.verify(digest, password, { secret: pepper });
  } catch {
    return false;
  }
};

export interface PasswordVerification {
  readonly valid: boolean;
  /** The hash is valid but weaker than {@link ARGON2_PARAMETERS}; replace it. */
  readonly needsRehash: boolean;
}

/**
 * Hashes and verifies staff passwords. One instance per process holds the
 * pepper, so no caller ever passes key material around.
 */
export class PasswordHasher {
  readonly #pepper: Buffer;
  readonly #previousPepper: Buffer | undefined;
  #decoy: Promise<string> | null = null;

  constructor(masterKey: Buffer, previousMasterKey?: Buffer) {
    this.#pepper = derivePepper(masterKey);
    this.#previousPepper =
      previousMasterKey === undefined ? undefined : derivePepper(previousMasterKey);
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, { ...ARGON2_PARAMETERS, secret: this.#pepper });
  }

  async verify(digest: string, password: string): Promise<PasswordVerification> {
    if (await verifyWith(digest, password, this.#pepper)) {
      return { valid: true, needsRehash: this.#needsRehash(digest) };
    }

    const previous =
      this.#previousPepper !== undefined &&
      (await verifyWith(digest, password, this.#previousPepper));

    return { valid: previous, needsRehash: previous };
  }

  /**
   * Spends the same work as a real verification against a hash nobody knows the
   * password to. It is what an unknown address is answered with, so that "no
   * such user" and "wrong password" cost the same and the form cannot be used
   * to enumerate who works here (REQUIREMENTS §5.1).
   *
   * The decoy is hashed once per process and reused: hashing it per request
   * would double the cost of every failed sign-in, and its value is not a
   * secret — only that verifying it takes the same time as verifying a real one.
   */
  async burnVerificationTime(password: string): Promise<void> {
    // A rejected promise left in the cache would make every later unknown
    // address answer 500 while a known one answered 401 — the oracle this
    // method exists to close, reopened by a transient failure.
    this.#decoy ??= this.hash(randomBytes(32).toString('base64url')).catch((error: unknown) => {
      this.#decoy = null;
      throw error;
    });

    // A known address with a wrong password is tried under both peppers while
    // a rotation is under way, so an unknown one costs both as well.
    const decoy = await this.#decoy;
    await verifyWith(decoy, password, this.#pepper);
    if (this.#previousPepper !== undefined) {
      await verifyWith(decoy, password, this.#previousPepper);
    }
  }

  #needsRehash(digest: string): boolean {
    // A hash this process cannot even read the parameters of is one it should
    // not keep, so it is rehashed rather than trusted.
    if (!digest.startsWith('$argon2id$')) {
      return true;
    }

    try {
      return argon2.needsRehash(digest, ARGON2_PARAMETERS);
    } catch {
      return true;
    }
  }
}

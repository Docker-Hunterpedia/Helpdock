import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMETERS, derivePepper, PasswordHasher } from './password.js';

const MASTER_KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe('derivePepper', () => {
  it('is deterministic, or every restart would invalidate every password', () => {
    expect(derivePepper(MASTER_KEY)).toEqual(derivePepper(MASTER_KEY));
  });

  it('is not the master key itself, so one leak is not the other', () => {
    expect(derivePepper(MASTER_KEY).equals(MASTER_KEY)).toBe(false);
  });

  it('differs per master key', () => {
    expect(derivePepper(MASTER_KEY).equals(derivePepper(OTHER_KEY))).toBe(false);
  });
});

describe('PasswordHasher', () => {
  it('produces an argon2id hash with at least the OWASP minimum parameters', async () => {
    const hash = await new PasswordHasher(MASTER_KEY).hash('correct horse battery');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain(`m=${ARGON2_PARAMETERS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_PARAMETERS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_PARAMETERS.parallelism}`);
  });

  it('accepts the right password and refuses a wrong one', async () => {
    const hasher = new PasswordHasher(MASTER_KEY);
    const hash = await hasher.hash('correct horse battery');

    await expect(hasher.verify(hash, 'correct horse battery')).resolves.toMatchObject({
      valid: true,
      needsRehash: false,
    });
    await expect(hasher.verify(hash, 'wrong horse battery')).resolves.toMatchObject({
      valid: false,
    });
  });

  it('refuses the right password under a different master key: the pepper is not stored', async () => {
    const hash = await new PasswordHasher(MASTER_KEY).hash('correct horse battery');

    await expect(
      new PasswordHasher(OTHER_KEY).verify(hash, 'correct horse battery'),
    ).resolves.toMatchObject({ valid: false });
  });

  it('asks for a rehash when the stored hash is weaker than the current parameters', async () => {
    const hasher = new PasswordHasher(MASTER_KEY);
    const legacy = await argon2.hash('correct horse battery', {
      type: argon2.argon2id,
      memoryCost: 4_096,
      timeCost: 1,
      parallelism: 1,
      secret: derivePepper(MASTER_KEY),
    });

    await expect(hasher.verify(legacy, 'correct horse battery')).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it('asks for a rehash for a hash that is not argon2id at all', async () => {
    const hasher = new PasswordHasher(MASTER_KEY);
    const argon2i = await argon2.hash('correct horse battery', {
      type: argon2.argon2i,
      ...{ memoryCost: ARGON2_PARAMETERS.memoryCost, timeCost: 2, parallelism: 1 },
      secret: derivePepper(MASTER_KEY),
    });

    await expect(hasher.verify(argon2i, 'correct horse battery')).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it('never asks for a rehash of a hash it just refused', async () => {
    const hasher = new PasswordHasher(MASTER_KEY);
    const hash = await hasher.hash('correct horse battery');

    await expect(hasher.verify(hash, 'nope')).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('answers false rather than throwing for a digest that is not a hash', async () => {
    await expect(new PasswordHasher(MASTER_KEY).verify('not-a-hash', 'x')).resolves.toMatchObject({
      valid: false,
    });
  });

  it('spends real argon2 work on an unknown address rather than returning early', async () => {
    // Not a timing-equality assertion: a wall clock on a shared runner cannot
    // establish that, and a test that tries is flaky. What it establishes is
    // that the decoy path does a verification at all — the regression it
    // guards is somebody turning it into an early return, which would make the
    // sign-in form an address oracle with a stopwatch.
    const hasher = new PasswordHasher(MASTER_KEY);
    await hasher.burnVerificationTime('warm the decoy');

    const started = process.hrtime.bigint();
    await hasher.burnVerificationTime('wrong horse battery');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(elapsedMs).toBeGreaterThan(5);
  });
});

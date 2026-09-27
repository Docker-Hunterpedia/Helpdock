import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Does the key a person typed into step 1 match `HD_SETUP_TOKEN` (#43)?
 *
 * Both sides are hashed first so the comparison is always between two 32-byte
 * digests: `timingSafeEqual` refuses buffers of different lengths, and
 * answering that early would tell a caller how long the real key is. A missing
 * key is compared too, as the empty string, so it takes the same path as a
 * wrong one.
 */
export const setupKeyMatches = (expected: string, presented: string | undefined): boolean => {
  const matches = timingSafeEqual(digest(expected), digest(presented ?? ''));

  return matches && presented !== undefined;
};

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

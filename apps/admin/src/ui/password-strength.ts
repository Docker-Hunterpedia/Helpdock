/**
 * How strong a password looks, for the four-segment bar under the field.
 *
 * **What this is not.** It is not a policy. The only rule the api enforces is
 * twelve characters, which is the floor NIST SP 800-63B sets when no
 * composition rules are imposed — and none are, deliberately, because
 * composition rules push people towards `Passw0rd!` and away from the long
 * ordinary phrases that are actually hard to guess.
 *
 * **What it is.** A hint that rewards length far more than variety, because
 * length is what actually costs an attacker, and that notices the three shapes
 * a person types when they are not really trying: one repeated character, a
 * keyboard run, and a plain number. It runs in the browser and nothing is sent
 * anywhere, which is why it is a small function here rather than a library or
 * an endpoint.
 */

import { PASSWORD_MIN_LENGTH } from '@helpdock/schemas';

export const PASSWORD_STRENGTH_LEVELS = ['weak', 'fair', 'good', 'strong'] as const;
export type PasswordStrengthLevel = (typeof PASSWORD_STRENGTH_LEVELS)[number];

export interface PasswordStrength {
  /** 0 to 3, matching the index of {@link PASSWORD_STRENGTH_LEVELS}. */
  readonly score: 0 | 1 | 2 | 3;
  readonly level: PasswordStrengthLevel;
}

const CLASSES: readonly RegExp[] = [/[a-z]/, /[A-Z]/, /\d/, /[^\da-zA-Z]/];

/** Three or more of the same character in a row: `aaa`, `111`. */
const REPEATED = /(.)\1{2,}/;

/** Four or more characters that step by one, in either direction: `abcd`, `4321`. */
const hasRun = (value: string): boolean => {
  let run = 1;

  for (let index = 1; index < value.length; index += 1) {
    const step = (value.codePointAt(index) ?? 0) - (value.codePointAt(index - 1) ?? 0);
    run = step === 1 || step === -1 ? run + 1 : 1;
    if (run >= 4) {
      return true;
    }
  }

  return false;
};

const clamp = (score: number): 0 | 1 | 2 | 3 => Math.max(0, Math.min(3, score)) as 0 | 1 | 2 | 3;

export const passwordStrength = (password: string): PasswordStrength => {
  const value = password.trim();

  if (value.length === 0) {
    return { score: 0, level: 'weak' };
  }

  // Length carries the score: a sixteen-character phrase beats a twelve
  // character one with a symbol in it, which is the truth of the matter.
  let score = 0;
  if (value.length >= PASSWORD_MIN_LENGTH) {
    score += 1;
  }
  if (value.length >= 16) {
    score += 1;
  }
  if (value.length >= 20) {
    score += 1;
  }

  const variety = CLASSES.filter((pattern) => pattern.test(value)).length;
  if (variety >= 3 && value.length >= PASSWORD_MIN_LENGTH) {
    score += 1;
  }

  // The shapes that look long and are not.
  if (REPEATED.test(value) || hasRun(value) || /^\d+$/.test(value)) {
    score -= 1;
  }

  // Below the floor the api enforces, nothing earns more than "weak": the bar
  // must never say "good" about a password the form is about to refuse.
  if (value.length < PASSWORD_MIN_LENGTH) {
    score = 0;
  }

  const bounded = clamp(score);

  return { score: bounded, level: PASSWORD_STRENGTH_LEVELS[bounded] ?? 'weak' };
};

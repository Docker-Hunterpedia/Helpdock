import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'otplib';

/**
 * An authenticator code the api has not accepted yet.
 *
 * The api takes each thirty-second step of an account's authenticator once
 * (ASVS 2.8.4), and this suite signs the same account in many times in a row,
 * as a person never would. So it remembers the last step it used per secret and
 * moves on: to the next step, which the window of one already accepts, or —
 * when that one is spent too — it waits for the clock to reach it.
 *
 * The memory is a file, not module state. Playwright starts a fresh worker
 * process after a failed test, and that process would otherwise begin from
 * the clock, present the step the last worker had just spent, and be refused —
 * which turned one failure into a failed sign-in for every spec after it.
 *
 * It lives under this app's own `test-results/`, which is git-ignored and
 * belongs to whoever runs the suite, rather than in the shared system temp
 * directory where another user on the machine could pre-create or swap the file.
 */

const PERIOD_SECONDS = 30;
const STATE_DIR = fileURLToPath(new URL('../../test-results/totp-state/', import.meta.url));

const currentStep = (): number => Math.floor(Date.now() / 1000 / PERIOD_SECONDS);

/** Keyed by a digest, so the secret itself is never written anywhere. */
const stateFile = (secret: string): string =>
  path.join(STATE_DIR, createHash('sha256').update(secret).digest('hex').slice(0, 32));

const lastUsedStep = (secret: string): number | undefined => {
  try {
    const step = Number(readFileSync(stateFile(secret), 'utf8'));
    return Number.isInteger(step) ? step : undefined;
  } catch {
    return undefined;
  }
};

const rememberStep = (secret: string, step: number): void => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile(secret), String(step));
};

export const freshTotpCode = async (secret: string): Promise<string> => {
  const used = lastUsedStep(secret);
  const step = used === undefined ? currentStep() : Math.max(currentStep(), used + 1);

  // A step more than one ahead of the clock is outside the window; wait for it.
  while (step > currentStep() + 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  rememberStep(secret, step);
  return generate({ secret, period: PERIOD_SECONDS, epoch: step * PERIOD_SECONDS });
};

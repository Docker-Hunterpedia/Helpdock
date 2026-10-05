import { generate } from 'otplib';

/**
 * An authenticator code the api has not accepted yet.
 *
 * The api takes each thirty-second step of an account's authenticator once
 * (ASVS 2.8.4), and this suite signs the same account in many times in a row,
 * as a person never would. So it remembers the last step it used per secret and
 * moves on: to the next step, which the window of one already accepts, or —
 * when that one is spent too — it waits for the clock to reach it. The suite
 * runs in one worker, so module state is the whole suite's.
 */

const PERIOD_SECONDS = 30;
const lastStep = new Map<string, number>();

const currentStep = (): number => Math.floor(Date.now() / 1000 / PERIOD_SECONDS);

export const freshTotpCode = async (secret: string): Promise<string> => {
  const used = lastStep.get(secret);
  const step = used === undefined ? currentStep() : Math.max(currentStep(), used + 1);

  // A step more than one ahead of the clock is outside the window; wait for it.
  while (step > currentStep() + 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  lastStep.set(secret, step);
  return generate({ secret, period: PERIOD_SECONDS, epoch: step * PERIOD_SECONDS });
};

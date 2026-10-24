import { z } from 'zod';
import { passkeyProofSchema } from './passkeys.js';

/**
 * An install admin resetting another person's second factor (#398,
 * DOMAIN-RULES §12.1 rule 8).
 *
 * The summary is what the confirm dialog lists, read from the server so the
 * counts are the ones the reset will remove. Its `digest` names that exact set
 * of factors: the reset carries it back, and the api answers
 * `second-factor-changed` when the person's factors are no longer the ones the
 * admin was shown.
 */

const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);

export const secondFactorSummarySchema = z.object({
  /** Whether an authenticator app is on. */
  totp: z.boolean(),
  passkeys: z.number().int().min(0),
  /** Unused recovery codes. */
  recoveryCodes: z.number().int().min(0),
  /** Whether the person's role requires a second factor: they enrol at next sign-in, rather than choose to. */
  enrolmentRequired: z.boolean(),
  digest: DIGEST,
});
export type SecondFactorSummary = z.infer<typeof secondFactorSummarySchema>;

/** The admin's own step-up (password, app code or passkey) and the digest they confirmed. */
export const secondFactorResetRequestSchema = z.object({
  proof: passkeyProofSchema,
  digest: DIGEST,
});
export type SecondFactorResetRequest = z.infer<typeof secondFactorResetRequestSchema>;

/** What the reset removed. */
export const secondFactorResetSchema = z.object({
  totp: z.boolean(),
  passkeys: z.number().int().min(0),
  recoveryCodes: z.number().int().min(0),
});
export type SecondFactorReset = z.infer<typeof secondFactorResetSchema>;

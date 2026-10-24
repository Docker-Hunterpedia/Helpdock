import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, totpEnrolmentSchema } from './auth.js';
import { authenticationResponseSchema, CEREMONY_ID } from './passkeys.js';
import { totpCodeRequestSchema } from './staff.js';

/**
 * Replacing an authenticator app in one step (#373): the wire shapes of the
 * step-up that starts it and of the confirmation that finishes it.
 *
 * The proof is one of exactly four, per DOMAIN-RULES §12.1: a live code from
 * the current app, a single-use recovery code, an assertion from a passkey the
 * account holds, or the current password **plus** a recovery code. A session
 * proves somebody signed in, not who is at the keyboard now — and the app
 * being replaced is the thing a stolen session would most like to swap.
 */

/** A recovery code as the person types it: the `RC-` shape, tolerating spaces and case. */
const recoveryCode = z.string().min(1).max(32);

export const totpRotationProofSchema = z
  .strictObject({
    /** A live code from the authenticator being replaced. */
    code: totpCodeRequestSchema.shape.code.optional(),
    /** A single-use recovery code, for the day the phone is gone. Spent on success. */
    recoveryCode: recoveryCode.optional(),
    /** Only ever beside `recoveryCode`: the fresh first factor of the pair. */
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
    /** An assertion from a held passkey, in answer to `POST /api/me/passkeys/step-up/options`. */
    passkey: z
      .object({ ceremonyId: CEREMONY_ID, response: authenticationResponseSchema })
      .optional(),
  })
  .refine((value) => {
    const has = {
      code: value.code !== undefined,
      recoveryCode: value.recoveryCode !== undefined,
      currentPassword: value.currentPassword !== undefined,
      passkey: value.passkey !== undefined,
    };
    // Exactly one of the four shapes, and nothing beside it: a stray field is
    // a proof the server would otherwise ignore without saying so.
    return (
      (has.code && !has.recoveryCode && !has.currentPassword && !has.passkey) ||
      (has.recoveryCode && !has.currentPassword && !has.code && !has.passkey) ||
      (has.passkey && !has.code && !has.recoveryCode && !has.currentPassword) ||
      (has.recoveryCode && has.currentPassword && !has.code && !has.passkey)
    );
  }, 'Send an authentication code, a recovery code, a passkey assertion, or the password with a recovery code — one proof only');
export type TotpRotationProof = z.infer<typeof totpRotationProofSchema>;

/** What a rotation start returns: the staged secret for the QR, and the id the confirmation names. */
export const totpRotationStartSchema = totpEnrolmentSchema.extend({
  /** Names the staged secret at the confirmation; nothing is replaced until it verifies a code. */
  rotationId: z.uuid(),
});
export type TotpRotationStart = z.infer<typeof totpRotationStartSchema>;

export const totpRotationConfirmRequestSchema = z.object({
  rotationId: z.uuid(),
  code: totpCodeRequestSchema.shape.code,
});
export type TotpRotationConfirmRequest = z.infer<typeof totpRotationConfirmRequestSchema>;

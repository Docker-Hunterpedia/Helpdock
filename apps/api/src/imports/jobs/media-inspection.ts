import {
  type ImportAttachmentAvailability,
  importMediaInspectionOutcomeSchema,
} from '@helpdock/schemas';
import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const importMediaInspectionSchema = z.strictObject({
  version: z.literal(1),
  fingerprint: digest,
  payloadHash: digest,
  policyHash: digest,
  outcome: importMediaInspectionOutcomeSchema,
});

/** A receipt from another source revision, policy or review cannot imply availability. */
export function inspectedAttachmentAvailability(
  raw: unknown,
  binding: { fingerprint: string; payloadHash: string; policyHash: string },
): ImportAttachmentAvailability {
  const parsed = importMediaInspectionSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.fingerprint !== binding.fingerprint ||
    parsed.data.payloadHash !== binding.payloadHash ||
    parsed.data.policyHash !== binding.policyHash
  )
    return { state: 'not_checked' };
  const { outcome } = parsed.data;
  return outcome.state === 'available'
    ? outcome
    : {
        state: outcome.state === 'warning' ? 'unavailable' : 'rejected',
        code: outcome.code,
      };
}

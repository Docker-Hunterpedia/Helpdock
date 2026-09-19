import { z } from 'zod';
import { authErrorSchema } from './auth.js';
import { contactRefusalSchema, identityProblemSchema } from './contact.js';
import { staffRefusalSchema } from './staff.js';

/**
 * The one body shape every failed request answers with. The api's exception
 * filter builds it and `apps/admin` parses it, so it lives here rather than in
 * either of them.
 *
 * `requestId` is the only detail that ever leaves the process for an unexpected
 * failure: it is what an operator greps the log for.
 */

export const errorCodeSchema = z.enum([
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** One rejected field, addressed as the request carried it (`body.email`, `params.brandId`). */
export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    fields: z.array(fieldErrorSchema).optional(),
    /**
     * Only on a sign-in failure. The sign-in screens turn this into a
     * translated sentence and count the remaining attempts down with it, which
     * `code` above is too coarse for (M0-05).
     */
    auth: authErrorSchema.optional(),
    /**
     * Only on a refused staff action (M0-06). The status already says
     * "forbidden" or "conflict"; this says *which* rule of DOMAIN-RULES §12
     * refused, which is what the staff screen turns into a sentence.
     */
    staff: z.object({ reason: staffRefusalSchema }).optional(),
    /**
     * Only on a refused contact action (M1-04), and read the same way: which
     * rule refused, and — when an identifier was the problem — how it was
     * wrong, so the field's hint can say "that is not an email address" rather
     * than "that did not work".
     */
    contact: z
      .object({ reason: contactRefusalSchema, problem: identityProblemSchema.optional() })
      .optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

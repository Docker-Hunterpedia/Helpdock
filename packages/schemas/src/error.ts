import { z } from 'zod';

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
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

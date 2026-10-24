import { z } from 'zod';
import { aiRefusalSchema } from './ai.js';
import { webhooksRefusalSchema } from './api.js';
import { assistRefusalSchema } from './assist.js';
import { authErrorSchema } from './auth.js';
import { contactRefusalSchema, identityProblemSchema } from './contact.js';
import { domainsRefusalSchema } from './domains.js';
import { channelsRefusalSchema } from './email-inbound.js';
import { hcRefusalSchema } from './help-center.js';
import { setupRefusalSchema } from './install.js';
import { knowledgeRefusalSchema } from './knowledge.js';
import { metaRefusalDetailsSchema, metaRefusalSchema } from './meta.js';
import { passkeysRefusalSchema } from './passkeys.js';
import { ssoRefusalSchema } from './sso.js';
import { staffRefusalSchema } from './staff.js';
import { telegramRefusalSchema } from './telegram.js';
import { ticketLifecycleRefusalSchema } from './ticket.js';
import { ticketingRefusalSchema } from './ticketing.js';
import { widgetErrorCodeSchema } from './widget-protocol.js';

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
  'gone',
  'rate_limited',
  'unavailable',
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
     * Only on an auth failure: a refused sign-in or step-up, or another of the
     * refusals in `authErrorCodeSchema`. The screens turn this into a translated sentence and count the
     * remaining attempts down with it, which `code` above is too coarse for
     * (M0-05). Its absence on a 401 is what marks the guard refusing the
     * access token, the one 401 the admin refreshes and retries for (#271).
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
    /**
     * Only on a refused ticketing-settings action (M1-01). Same idea as
     * `staff` above: the status says "forbidden" or "conflict", this says
     * which rule refused, and the Ticketing screen turns it into a sentence.
     */
    ticketing: z
      .object({
        reason: ticketingRefusalSchema,
        /** #361. The live tickets a status state change would touch. */
        count: z.int().nonnegative().optional(),
      })
      .optional(),
    /**
     * Only on a transition DOMAIN-RULES §2.2 has no row for, or a close the
     * required-to-close fields stop (M1-08, M14-17). The status is 409 for all
     * of them, so the ticket workspace reads this to say whether the ticket is
     * merged, deleted, was never closed — or which fields are still empty,
     * which `fields` names.
     */
    lifecycle: z
      .object({ reason: ticketLifecycleRefusalSchema, fields: z.array(z.string()).optional() })
      .optional(),
    /**
     * Only on a refused first-run wizard step (#43). The wizard shows the setup
     * key's error line on this rather than a generic failure banner.
     */
    setup: z.object({ reason: setupRefusalSchema }).optional(),
    /** Only on a refused mailbox action (M2-08). */
    channels: z.object({ reason: channelsRefusalSchema }).optional(),
    /** Only on a refused custom-domain action (M5-07). */
    domains: z.object({ reason: domainsRefusalSchema }).optional(),
    /** Only on a refused move of the install's passkeys (M18-06). */
    passkeys: z.object({ reason: passkeysRefusalSchema }).optional(),
    /** Only on a refused widget request (M4-02 to M4-04); the widget translates it. */
    widget: z.object({ reason: widgetErrorCodeSchema }).optional(),
    /** Only on a refused help center change (M5-01). */
    helpCenter: z.object({ reason: hcRefusalSchema }).optional(),
    /** Only on a refused AI settings change (M7-01, M7-02). */
    ai: z.object({ reason: aiRefusalSchema }).optional(),
    /** Only on a refused agent assist request or proposal decision (M7-05). */
    assist: z.object({ reason: assistRefusalSchema }).optional(),
    /** Only on a refused knowledge source action (M7-03). */
    knowledge: z.object({ reason: knowledgeRefusalSchema }).optional(),
    /** Only on a refused Telegram bot action (M6-05). */
    telegram: z.object({ reason: telegramRefusalSchema }).optional(),
    /**
     * Only on a refused Meta channel action (M10). `details` is there for a
     * reply the reply window refused: which platform, and when it closed.
     */
    meta: z
      .object({ reason: metaRefusalSchema, details: metaRefusalDetailsSchema.optional() })
      .optional(),
    /**
     * Only on a refused webhook endpoint (M8-03): `address` is what the name
     * resolved to, so the form can say which private address it was.
     */
    webhooks: z
      .object({ reason: webhooksRefusalSchema, address: z.string().optional() })
      .optional(),
    /**
     * Only on a refused SSO connection save (M11). `domains` names the email
     * domains another enabled connection already lists.
     */
    sso: z.object({ reason: ssoRefusalSchema, domains: z.array(z.string()).optional() }).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

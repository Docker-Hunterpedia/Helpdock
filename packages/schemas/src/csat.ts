import { z } from 'zod';
import { localeSchema } from './brand.js';

/**
 * Customer satisfaction (REQUIREMENTS §4.1, M1-12): one survey per close, a
 * rating of 1–5 and an optional comment, reached through a single-use signed
 * link (DOMAIN-RULES §4.6).
 *
 * Two audiences read this file. The agent sees {@link ticketCsatSchema} in the
 * ticket's details panel; the customer sees {@link csatSurveyViewSchema} on the
 * public rating page, which carries the brand and the ticket's reference and
 * subject and nothing more — a link forwarded to the wrong person must not
 * become a window onto the ticket.
 */

export const CSAT_RATING_MIN = 1;
export const CSAT_RATING_MAX = 5;
export const CSAT_COMMENT_MAX = 2000;
/** DOMAIN-RULES §4.6: "CSAT 30 days". */
export const CSAT_TOKEN_TTL_DAYS = 30;

/**
 * Two base64url halves of 32 bytes each: the brand and survey ids, and the
 * HMAC over them. The shape is checked before anything is computed, so a
 * malformed path is a 400 and never a lookup.
 */
export const CSAT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

export const csatRatingSchema = z.int().min(CSAT_RATING_MIN).max(CSAT_RATING_MAX);

/**
 * Where a survey stands, as the agent sees it.
 *
 * - `pending`: created on close, not handed to a channel yet. Delivery is wired
 *   per channel later (M8-06), so until then every unrated survey is pending
 *   and the agent shares the link by hand, as `AdminTicketingFeedback` says.
 * - `sent`: a channel delivered it.
 * - `rated`: the customer answered; `rating` and `comment` are filled.
 * - `expired`: thirty days passed without an answer.
 */
export const csatStateSchema = z.enum(['pending', 'sent', 'rated', 'expired']);
export type CsatState = z.infer<typeof csatStateSchema>;

export const ticketCsatSchema = z.object({
  state: csatStateSchema,
  rating: csatRatingSchema.nullable(),
  comment: z.string().nullable(),
  /**
   * The rating page's address, while it can still be used. Null once it is
   * rated or expired, and null when the key that signed it has been rotated out.
   */
  link: z.url().nullable(),
  expiresAt: z.iso.datetime(),
  ratedAt: z.iso.datetime().nullable(),
});
export type TicketCsat = z.infer<typeof ticketCsatSchema>;

// --------------------------------------------------------------------------
// The public rating page
// --------------------------------------------------------------------------

export const csatTokenParamSchema = z.object({
  token: z.string().regex(CSAT_TOKEN_PATTERN),
});
export type CsatTokenParam = z.infer<typeof csatTokenParamSchema>;

/** What the page is themed and worded with. */
export const csatBrandSchema = z.object({
  name: z.string(),
  locale: localeSchema,
  /**
   * The brand accent, when the brand has one. Brands carry no theme until the
   * help center and widget themes land (M5, M6), so today this is always null
   * and the page uses the stock accent.
   */
  accent: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable(),
});
export type CsatBrand = z.infer<typeof csatBrandSchema>;

/**
 * The four screens the page can draw. `used` and `expired` carry the brand and
 * nothing else: `CsatEN` says "nothing on this page reveals the ticket subject
 * or the agent's name" once the link is spent.
 */
export const csatSurveyViewSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('open'),
    brand: csatBrandSchema,
    ticket: z.object({
      reference: z.string(),
      subject: z.string(),
      /**
       * The first name of the staff member who closed the ticket — "closed by
       * Lina" — or null unless that was a current staff member who wrote a
       * public reply on it (not an api key, a rule, somebody since deactivated
       * or removed, or somebody the customer never heard from). First name
       * only, and only while the link is open, so it names nobody the customer
       * has not already had a reply from (DOMAIN-RULES §4.6).
       */
      closedBy: z.string().min(1).nullable(),
    }),
  }),
  z.object({ state: z.literal('rated'), brand: csatBrandSchema, rating: csatRatingSchema }),
  z.object({ state: z.literal('used'), brand: csatBrandSchema }),
  z.object({ state: z.literal('expired'), brand: csatBrandSchema }),
]);
export type CsatSurveyView = z.infer<typeof csatSurveyViewSchema>;

export const csatSubmitRequestSchema = z.object({
  rating: csatRatingSchema,
  /** Trimmed; a blank comment is stored as none. */
  comment: z.string().trim().max(CSAT_COMMENT_MAX).optional(),
});
export type CsatSubmitRequest = z.infer<typeof csatSubmitRequestSchema>;

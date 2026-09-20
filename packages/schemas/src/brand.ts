import { z } from 'zod';

/** The interface and content languages Helpdock ships with (REQUIREMENTS §3). */
export const localeSchema = z.enum(['en', 'ar']);

/** `deleting` is the 30-day grace window of DOMAIN-RULES §11. */
export const brandStatusSchema = z.enum(['active', 'deleting', 'deleted']);

/**
 * `Intl.supportedValuesOf('timeZone')` is the list every current browser and
 * Node 24 agree on, so the picker and the api validate against the same names.
 * It leaves out `UTC`, which is the column default and a perfectly good answer
 * for an install that has not decided yet, so it is added back.
 */
let timeZones: ReadonlySet<string> | undefined;

export const supportedTimeZones = (): ReadonlySet<string> => {
  timeZones ??= new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

  return timeZones;
};

export const isSupportedTimeZone = (value: string): boolean => supportedTimeZones().has(value);

export const timezoneSchema = z
  .string()
  .refine(isSupportedTimeZone, 'must be an IANA time zone name');

// --------------------------------------------------------------------------
// Brand-level ticketing settings (M1-01)
// --------------------------------------------------------------------------

/**
 * What a customer reply to a closed ticket does (DOMAIN-RULES §2.3). A
 * discriminated union rather than a nullable number, so "always" and "never"
 * cannot be written as a day count nobody reads, and so a fourth rule later is
 * a new member instead of a new meaning for an old field.
 */
export const REOPEN_WITHIN_DAYS_DEFAULT = 7;
export const REOPEN_WITHIN_DAYS_MAX = 365;

export const reopenPolicySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('within_days'),
    days: z.int().min(1).max(REOPEN_WITHIN_DAYS_MAX),
  }),
  z.object({ kind: z.literal('always') }),
  z.object({ kind: z.literal('never') }),
]);
export type ReopenPolicy = z.infer<typeof reopenPolicySchema>;

/**
 * The `brands.settings` column: per-brand ticketing behaviour that later
 * deliverables read. M1-01 stores and serves it; M1-08 is what acts on it.
 *
 * Every key carries a default, so a row written before a key existed parses
 * into the current shape instead of failing. That is what makes adding a key a
 * migration nobody has to write: the column keeps its old JSON and the schema
 * fills the gap on the way out.
 */
export const brandSettingsSchema = z.object({
  /**
   * Moves a ticket to "Awaiting customer" when an agent sends a public reply
   * (DOMAIN-RULES §2.1). On by default, as that rule says.
   */
  autoAwaitOnAgentReply: z.boolean().default(true),
  reopenPolicy: reopenPolicySchema.default({
    kind: 'within_days',
    days: REOPEN_WITHIN_DAYS_DEFAULT,
  }),
});
export type BrandSettings = z.infer<typeof brandSettingsSchema>;

/** What a brand starts with, and what an unreadable column falls back to. */
export const defaultBrandSettings = (): BrandSettings => brandSettingsSchema.parse({});

/**
 * The "Reply behaviour" card of `Admin/Ticketing` (M1-08): the two settings
 * DOMAIN-RULES §2.3 lets a **Team Leader** change, and no others.
 *
 * It is a route of its own rather than a corner of `PATCH /api/brands/:brandId`
 * because that body also carries the brand's time zone, which SLA clocks run
 * on and which §1.2 keeps with the Admin. A narrower body is the only way to
 * give a Team Leader the reopen policy without giving them the rest.
 *
 * Both fields are optional and sending neither is refused, so "it worked" and
 * "there was nothing to do" cannot look the same to a caller retrying a write.
 */
export const replyBehaviourUpdateRequestSchema = z
  .object({
    autoAwaitOnAgentReply: z.boolean().optional(),
    reopenPolicy: reopenPolicySchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type ReplyBehaviourUpdateRequest = z.infer<typeof replyBehaviourUpdateRequestSchema>;

/**
 * The stored value, made safe to serve. A column that predates a key, or one an
 * operator edited by hand into something the schema refuses, becomes the
 * defaults rather than a 500: these settings describe behaviour, and behaviour
 * has to have an answer.
 */
export const parseBrandSettings = (value: unknown): BrandSettings => {
  const parsed = brandSettingsSchema.safeParse(value);

  return parsed.success ? parsed.data : defaultBrandSettings();
};

/**
 * A brand as the API returns it. Deliberately narrower than the row: nothing
 * here may leak a column a later milestone adds, because the output schema is
 * what the response is parsed through (ARCHITECTURE §6).
 */
export const brandSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  defaultLocale: localeSchema,
  timezone: z.string(),
  status: brandStatusSchema,
  /** Per-brand ticketing behaviour (M1-01); see {@link brandSettingsSchema}. */
  settings: brandSettingsSchema,
});
export type Brand = z.infer<typeof brandSchema>;

export const brandListSchema = z.object({
  brands: z.array(brandSchema),
});
export type BrandList = z.infer<typeof brandListSchema>;

/** The `:brandId` path parameter, which is also what the permission guard scopes on. */
export const brandIdParamSchema = z.object({
  brandId: z.uuid(),
});
export type BrandIdParam = z.infer<typeof brandIdParamSchema>;

/**
 * What `PATCH /api/brands/:brandId` accepts. The prefix is absent on purpose:
 * it is printed in every ticket number ever issued, so REQUIREMENTS §3 makes it
 * editable once, at creation, and never again.
 *
 * `settings` is sent whole rather than partially — a half-sent object would
 * silently reset the key it left out, and the screen always holds the complete
 * value.
 */
export const brandUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    defaultLocale: localeSchema.optional(),
    // The wizard's own rule, imported rather than restated: a zone the wizard
    // accepts and this route refuses — or the other way round — would be two
    // answers to one question, and SLA clocks run on this value.
    timezone: timezoneSchema.optional(),
    settings: brandSettingsSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type BrandUpdateRequest = z.infer<typeof brandUpdateRequestSchema>;

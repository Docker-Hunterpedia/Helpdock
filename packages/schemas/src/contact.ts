import { z } from 'zod';
import { localeSchema } from './brand.js';

/**
 * Contacts and accounts (M1-04): the identifiers a person is recognised by, the
 * shapes the admin screens read, and the normalisation every channel runs
 * before it writes one.
 *
 * **Normalisation lives here, not in the api**, because the widget (M4) and the
 * channel adapters (M2, M6) all have to spell an identifier the same way as the
 * admin does, and `contact_identities` is unique on the spelled value. One
 * function per kind, no database, no configuration beyond the brand's calling
 * code, so every caller can be held to it by a unit test.
 */

// --------------------------------------------------------------------------
// Identifiers
// --------------------------------------------------------------------------

/** DOMAIN-RULES §4.4, in the order the contact screen lists them. */
export const contactIdentityKindSchema = z.enum([
  'email',
  'phone',
  'telegram',
  'visitor',
  'external',
]);
export type ContactIdentityKind = z.infer<typeof contactIdentityKindSchema>;

/**
 * Which identifiers can ever be verified, and by what
 * ([DOMAIN-RULES §4.4](../../../docs/planning/DOMAIN-RULES.md#44-contact-merge)).
 * A phone number is on this list as "never in v1": Helpdock sends no SMS, so
 * nothing can prove one, and an agent ticking a box would be a claim rather
 * than proof.
 */
export const VERIFIABLE_IDENTITY_KINDS: Readonly<Record<ContactIdentityKind, boolean>> =
  Object.freeze({
    email: true,
    telegram: true,
    external: true,
    visitor: true,
    phone: false,
  });

/** Why a normaliser refused a value. The screen turns the code into a sentence. */
export const identityProblemSchema = z.enum([
  'empty',
  'invalid-email',
  /** Not in `+<country><number>` form and the brand has no default calling code. */
  'phone-not-international',
  'invalid-phone',
  'invalid-telegram',
  'invalid-visitor',
  'too-long',
]);
export type IdentityProblem = z.infer<typeof identityProblemSchema>;

export type NormalisedIdentity = { readonly ok: true; readonly value: string };
export type IdentityRefusal = { readonly ok: false; readonly problem: IdentityProblem };
export type NormaliseResult = NormalisedIdentity | IdentityRefusal;

const ok = (value: string): NormaliseResult => ({ ok: true, value });
const refuse = (problem: IdentityProblem): NormaliseResult => ({ ok: false, problem });

/** RFC 5321's limit on an address, and the column everything else is stored in. */
export const MAX_IDENTITY_LENGTH = 320;

/**
 * Arabic-Indic (`٠١٢…`) and Eastern Arabic-Indic (`۰۱۲…`) digits to Latin.
 *
 * A person typing a phone number on an Arabic keyboard types Arabic-Indic
 * digits, and `+٩٦٣٩٣١٢٣٤٥٦٧` is the same number as `+963931234567`. Storing
 * both spellings would make one person two contacts, which is precisely what
 * the unique index on `contact_identities` exists to prevent.
 */
export const toLatinDigits = (value: string): string =>
  value.replaceAll(/[\u0660-\u0669\u06F0-\u06F9]/gu, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;

    return String(code - base);
  });

/** Lower-cased and trimmed. Case in the local part is not significant in practice. */
export const normaliseEmail = (raw: string): NormaliseResult => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return refuse('empty');
  }
  if (trimmed.length > MAX_IDENTITY_LENGTH) {
    return refuse('too-long');
  }

  const lowered = trimmed.toLowerCase();

  return z.email().safeParse(lowered).success ? ok(lowered) : refuse('invalid-email');
};

/** E.164 allows at most 15 digits, and no real number is shorter than 7. */
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;

/**
 * A phone number to E.164, by the narrow rule of ADR 0008: **international
 * format only**, plus one per-brand fallback.
 *
 * - Arabic-Indic digits become Latin, then every separator a person might type
 *   — spaces, hyphens, dots, brackets, the Arabic thousands separator — is
 *   dropped.
 * - A leading `00` is the international prefix written the European way and
 *   becomes `+`.
 * - With a leading `+`, what follows has to be 7 to 15 digits.
 * - Without one, `defaultCallingCode` (the brand's `contacts.defaultCallingCode`
 *   setting, digits only) is prefixed and a single national trunk `0` is
 *   dropped. With no such setting the number is refused, because guessing a
 *   country is how a support desk calls the wrong person.
 *
 * It deliberately does not know which country codes exist or how long a
 * national number is there; `libphonenumber-js` does, and ADR 0008 says why
 * that dependency is not worth its 145 kB here.
 */
export const normalisePhone = (
  raw: string,
  { defaultCallingCode = '' }: { readonly defaultCallingCode?: string } = {},
): NormaliseResult => {
  const trimmed = toLatinDigits(raw).trim();
  if (trimmed === '') {
    return refuse('empty');
  }

  const compact = trimmed.replaceAll(/[\s\u00A0\u066C().\-/]/gu, '');
  const international = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  if (international.startsWith('+')) {
    const digits = international.slice(1);

    return /^\d+$/.test(digits) && digits.length >= MIN_PHONE_DIGITS
      ? digits.length <= MAX_PHONE_DIGITS
        ? ok(`+${digits}`)
        : refuse('too-long')
      : refuse('invalid-phone');
  }

  if (!/^\d+$/.test(international)) {
    return refuse('invalid-phone');
  }

  const code = defaultCallingCode.replace(/^\+/, '');
  if (code === '' || !/^\d{1,4}$/.test(code)) {
    return refuse('phone-not-international');
  }

  const national = international.replace(/^0+/, '');
  if (national === '') {
    return refuse('invalid-phone');
  }

  return normalisePhone(`+${code}${national}`);
};

/**
 * A Telegram chat id, which the Bot API gives as a signed integer: positive for
 * a person, negative for a group. Stored as digits so the same chat cannot
 * arrive twice with different padding.
 */
export const normaliseTelegram = (raw: string): NormaliseResult => {
  const trimmed = toLatinDigits(raw).trim();
  if (trimmed === '') {
    return refuse('empty');
  }

  return /^-?\d{1,19}$/.test(trimmed) ? ok(trimmed) : refuse('invalid-telegram');
};

/** The UUIDv7 the widget was issued on first load (DOMAIN-RULES §4.1). */
export const normaliseVisitor = (raw: string): NormaliseResult => {
  const lowered = raw.trim().toLowerCase();
  if (lowered === '') {
    return refuse('empty');
  }

  return z.uuid().safeParse(lowered).success ? ok(lowered) : refuse('invalid-visitor');
};

/** The brand's own user id. Opaque: only trimmed, never case-folded. */
export const normaliseExternal = (raw: string): NormaliseResult => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return refuse('empty');
  }

  return trimmed.length > MAX_IDENTITY_LENGTH ? refuse('too-long') : ok(trimmed);
};

export interface NormaliseOptions {
  /** The brand's `contacts.defaultCallingCode`, used for phone numbers alone. */
  readonly defaultCallingCode?: string;
}

/** The one entry point every channel and every screen goes through. */
export const normaliseIdentity = (
  kind: ContactIdentityKind,
  value: string,
  options: NormaliseOptions = {},
): NormaliseResult => {
  switch (kind) {
    case 'email':
      return normaliseEmail(value);
    case 'phone':
      return normalisePhone(value, options);
    case 'telegram':
      return normaliseTelegram(value);
    case 'visitor':
      return normaliseVisitor(value);
    case 'external':
      return normaliseExternal(value);
  }
};

// --------------------------------------------------------------------------
// The wire shapes
// --------------------------------------------------------------------------

export const contactIdentitySchema = z.object({
  id: z.uuid(),
  kind: contactIdentityKindSchema,
  value: z.string().min(1).max(MAX_IDENTITY_LENGTH),
  verified: z.boolean(),
  verifiedAt: z.iso.datetime().nullable(),
  source: z.string().max(64),
});
export type ContactIdentity = z.infer<typeof contactIdentitySchema>;

export const accountSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  domain: z.string().max(253).nullable(),
  custom: z.record(z.string(), z.unknown()),
  contactCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type Account = z.infer<typeof accountSchema>;

/** Just enough of an account to draw the link on a contact row. */
export const accountRefSchema = z.object({ id: z.uuid(), name: z.string().min(1) });
export type AccountRef = z.infer<typeof accountRefSchema>;

/**
 * Counts the contact list and the stats tiles draw. They are all zero and null
 * until M1-02 creates tickets: the api serves them through a provider whose v1
 * implementation returns nothing, so the screens ship complete and the shape
 * does not change when tickets arrive.
 */
export const contactStatsSchema = z.object({
  openTickets: z.int().nonnegative(),
  totalTickets: z.int().nonnegative(),
  /** 0–100, or null when nobody has rated them. */
  csat: z.number().min(0).max(100).nullable(),
  /** Seconds, or null when there is nothing to average. */
  averageFirstReplySeconds: z.int().nonnegative().nullable(),
  lastTicketAt: z.iso.datetime().nullable(),
});
export type ContactStats = z.infer<typeof contactStatsSchema>;

/** One row of the contact table. */
export const contactSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  account: accountRefSchema.nullable(),
  /**
   * What the row shows under the name: the verified email if there is one, else
   * the first identifier there is. Null for a contact with none at all, which
   * an anonymous visitor is until they say who they are.
   */
  primaryIdentity: contactIdentitySchema.nullable(),
  /** Every kind they hold, for the channel icons. Deduplicated, in enum order. */
  channels: z.array(contactIdentityKindSchema),
  stats: contactStatsSchema,
  anonymised: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactSummary = z.infer<typeof contactSummarySchema>;

export const contactNoteSchema = z.object({
  id: z.uuid(),
  bodyText: z.string().min(1),
  authorId: z.uuid(),
  authorName: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type ContactNote = z.infer<typeof contactNoteSchema>;

/**
 * Why a pair was suggested (M1-13). An identifier kind means "they share this
 * identifier and one side of the match is not verified" (DOMAIN-RULES §4.4);
 * `similar_name` means "filed under the same account, with names that read
 * alike", which no identifier proves either way.
 */
export const contactDuplicateReasonSchema = z.enum([
  ...contactIdentityKindSchema.options,
  'similar_name',
]);
export type ContactDuplicateReason = z.infer<typeof contactDuplicateReasonSchema>;

export const contactDuplicateSuggestionSchema = z.object({
  id: z.uuid(),
  reason: contactDuplicateReasonSchema,
  other: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    primaryIdentity: contactIdentitySchema.nullable(),
    accountName: z.string().nullable(),
  }),
  /** True when both contacts are filed under the same account. */
  sameAccount: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ContactDuplicateSuggestion = z.infer<typeof contactDuplicateSuggestionSchema>;

/**
 * A merge into this contact that can still be undone (M1-13): the banner on the
 * surviving contact and the Undo in the toast. `undoUntil` is 24 hours after
 * `createdAt` (DOMAIN-RULES §4.4); a merge past it, or already undone, is not
 * listed at all.
 */
export const contactMergeSummarySchema = z.object({
  id: z.uuid(),
  mergedContact: z.object({ id: z.uuid(), name: z.string().min(1) }),
  /** Null when the staff member who merged has since been deleted. */
  actorName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  undoUntil: z.iso.datetime(),
});
export type ContactMergeSummary = z.infer<typeof contactMergeSummarySchema>;

export const contactDetailSchema = contactSummarySchema.extend({
  locale: localeSchema.nullable(),
  timezone: z.string().max(64).nullable(),
  externalId: z.string().max(MAX_IDENTITY_LENGTH).nullable(),
  custom: z.record(z.string(), z.unknown()),
  identities: z.array(contactIdentitySchema),
  notes: z.array(contactNoteSchema),
  duplicates: z.array(contactDuplicateSuggestionSchema),
  /**
   * Set when this contact was merged into another (M1-13). The screen follows
   * it to the survivor; nothing may be written to a merged contact.
   */
  mergedIntoId: z.uuid().nullable(),
  /** Merges into this contact that can still be undone, newest first. */
  merges: z.array(contactMergeSummarySchema),
});
export type ContactDetail = z.infer<typeof contactDetailSchema>;

/**
 * One entry of the contact timeline. M1-02 fills it; until then the list is
 * empty and `hiddenCount` is zero, and both come through the same provider so
 * the screen never learns that tickets did not exist yet.
 */
export const contactTimelineItemSchema = z.object({
  id: z.uuid(),
  /** `ACME-1042`, as the ticket screens print it. */
  reference: z.string().min(1).max(64),
  subject: z.string().min(1),
  status: z.string().min(1).max(64),
  channel: z.string().min(1).max(32),
  departmentName: z.string().nullable(),
  assigneeName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ContactTimelineItem = z.infer<typeof contactTimelineItemSchema>;

/**
 * DOMAIN-RULES §1.2: "the timeline shows a count of hidden tickets so the agent
 * knows history exists". The count is the whole point — it says history is
 * there without saying a word about what is in it.
 */
export const contactTimelineSchema = z.object({
  items: z.array(contactTimelineItemSchema),
  notes: z.array(contactNoteSchema),
  hiddenCount: z.int().nonnegative(),
});
export type ContactTimeline = z.infer<typeof contactTimelineSchema>;

export const contactListSchema = z.object({
  contacts: z.array(contactSummarySchema),
  /** Total matching the filters, for "1–50 of 412". */
  total: z.int().nonnegative(),
  /** Opaque; pass it back as `?cursor=` for the next page. Null on the last. */
  nextCursor: z.string().max(200).nullable(),
  /** How many open duplicate suggestions this brand has, for the review caption. */
  duplicateCount: z.int().nonnegative(),
});
export type ContactList = z.infer<typeof contactListSchema>;

/** One account with the people filed under it (the account detail screen). */
export const accountDetailSchema = z.object({
  account: accountSchema,
  contacts: z.array(contactSummarySchema),
});
export type AccountDetail = z.infer<typeof accountDetailSchema>;

export const accountListSchema = z.object({
  accounts: z.array(accountSchema),
  total: z.int().nonnegative(),
  nextCursor: z.string().max(200).nullable(),
});
export type AccountList = z.infer<typeof accountListSchema>;

// --------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------

export const CONTACT_PAGE_SIZE = 50;

/**
 * A boolean in a query string, parsed idempotently.
 *
 * `z.stringbool()` alone is not enough: a query is parsed by the global
 * `ZodValidationPipe` *and* by the one the parameter names, and the second pass
 * is handed the boolean the first produced — which `z.stringbool()` refuses,
 * so `?hasOpenTickets=true` answered 400. Accepting a boolean that is already
 * one makes the schema safe to apply twice, which is what a pipeline with two
 * pipes in it needs.
 */
const queryBoolean = z.union([z.boolean(), z.stringbool()]);

export const contactSearchQuerySchema = z.object({
  search: z.string().max(200).optional(),
  accountId: z.uuid().optional(),
  /** `true` narrows to contacts with at least one open ticket. */
  hasOpenTickets: queryBoolean.optional(),
  /**
   * Accepted and ignored. Tagging a *contact* is not M1-06's: tags hang off
   * tickets (`ticket_tags`), and REQUIREMENTS §4.1 asks for custom fields on a
   * contact, not tags. The parameter stays declared so the contact list's shape
   * does not change under the screens when something does tag a contact.
   */
  tag: z.string().max(64).optional(),
  /** Only the contacts an open duplicate suggestion points at. */
  duplicates: queryBoolean.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(CONTACT_PAGE_SIZE).optional(),
});
export type ContactSearchQuery = z.infer<typeof contactSearchQuerySchema>;

export const accountSearchQuerySchema = z.object({
  search: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(CONTACT_PAGE_SIZE).optional(),
});
export type AccountSearchQuery = z.infer<typeof accountSearchQuerySchema>;

/**
 * An identifier as a request states it. `verified` is accepted only from paths
 * that can prove it — a channel adapter, never the admin form, which sends it
 * as `false` and the api refuses anything else for a phone number.
 */
export const contactIdentityInputSchema = z.object({
  kind: contactIdentityKindSchema,
  value: z.string().min(1).max(MAX_IDENTITY_LENGTH),
});
export type ContactIdentityInput = z.infer<typeof contactIdentityInputSchema>;

export const contactCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  accountId: z.uuid().nullish(),
  locale: localeSchema.nullish(),
  timezone: z.string().max(64).nullish(),
  externalId: z.string().max(MAX_IDENTITY_LENGTH).nullish(),
  identities: z.array(contactIdentityInputSchema).max(20).default([]),
});
export type ContactCreateRequest = z.infer<typeof contactCreateRequestSchema>;

/** Every field optional; a body that changes nothing is refused with 400. */
export const contactUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    accountId: z.uuid().nullish(),
    locale: localeSchema.nullish(),
    timezone: z.string().max(64).nullish(),
    externalId: z.string().max(MAX_IDENTITY_LENGTH).nullish(),
    /**
     * Custom field values (M1-06), as a patch: an absent key is left alone and
     * a key set to `null` is cleared. Validated against the brand's *contact*
     * definitions by the api, so an unknown key is refused rather than stored
     * where nothing will ever read it.
     */
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Change at least one field' });
export type ContactUpdateRequest = z.infer<typeof contactUpdateRequestSchema>;

export const contactNoteRequestSchema = z.object({
  bodyText: z.string().trim().min(1).max(4_000),
});
export type ContactNoteRequest = z.infer<typeof contactNoteRequestSchema>;

export const accountCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(253).nullish(),
});
export type AccountCreateRequest = z.infer<typeof accountCreateRequestSchema>;

export const accountUpdateRequestSchema = accountCreateRequestSchema
  .partial()
  // The same patch semantics as a contact's, against the brand's *account*
  // definitions.
  .extend({ custom: z.record(z.string(), z.unknown()).optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Change at least one field' });
export type AccountUpdateRequest = z.infer<typeof accountUpdateRequestSchema>;

export const contactIdParamSchema = z.object({ brandId: z.uuid(), contactId: z.uuid() });
export type ContactIdParam = z.infer<typeof contactIdParamSchema>;

export const contactIdentityParamSchema = contactIdParamSchema.extend({ identityId: z.uuid() });
export type ContactIdentityParam = z.infer<typeof contactIdentityParamSchema>;

export const contactDuplicateParamSchema = contactIdParamSchema.extend({ suggestionId: z.uuid() });
export type ContactDuplicateParam = z.infer<typeof contactDuplicateParamSchema>;

export const accountIdParamSchema = z.object({ brandId: z.uuid(), accountId: z.uuid() });
export type AccountIdParam = z.infer<typeof accountIdParamSchema>;

/**
 * Why a contact action was refused, when the status code alone is too coarse to
 * turn into a sentence. As with `staffRefusalSchema`, the api sends the code and
 * the screen picks the catalog key, so no English crosses the boundary.
 */
export const contactRefusalSchema = z.enum([
  /** The normalised identifier already belongs to another contact in this brand. */
  'identity-taken',
  /** The value is not an identifier of that kind; `problem` says how. */
  'identity-invalid',
  /** Removing the last identifier of a contact that is not anonymised. */
  'last-identity',
  /** Only an Admin may erase a contact (DOMAIN-RULES §11). */
  'anonymise-forbidden',
  /** The contact has already been erased; nothing left to change. */
  'anonymised',
  /** Another account of this brand already claims that domain. */
  'domain-taken',
  /** The contact was merged into another (M1-13); change the survivor instead. */
  'merged',
  /** A contact cannot be merged into itself. */
  'merge-self',
  /** The 24 hours to undo this merge have passed, or it was already undone. */
  'merge-expired',
  /**
   * The merge cannot be undone because something happened to the contacts
   * since: the survivor was merged again, or either side was erased.
   */
  'merge-blocked',
]);
export type ContactRefusal = z.infer<typeof contactRefusalSchema>;

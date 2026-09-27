import { z } from 'zod';

/**
 * The inbound half of M2: mailboxes (M2-02, M2-08), the inbound-parse
 * endpoints (M2-03) and what the thread's email card draws (M2-04, M2-07).
 *
 * The outbound half — the brand's SMTP server, From and Reply-To per
 * department, auto-replies — is M2-05 and M2-06 and has its own schemas.
 */

// --------------------------------------------------------------------------
// Mailboxes
// --------------------------------------------------------------------------

export const mailboxMethodSchema = z.enum(['imap', 'inbound_parse']);
export type MailboxMethod = z.infer<typeof mailboxMethodSchema>;

export const mailboxSecuritySchema = z.enum(['tls', 'starttls']);
export type MailboxSecurity = z.infer<typeof mailboxSecuritySchema>;

export const remoteImagePolicySchema = z.enum(['block', 'proxy']);
export type RemoteImagePolicy = z.infer<typeof remoteImagePolicySchema>;

/** The four choices of the form's "Check every". The table's CHECK repeats them. */
export const POLL_INTERVALS_SECONDS = [30, 60, 120, 300] as const;
export const pollIntervalSchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(300),
]);
export type PollInterval = z.infer<typeof pollIntervalSchema>;

/**
 * The list's health column, from the artboard's legend:
 *
 * | State | Meaning |
 * |---|---|
 * | healthy | the last poll or delivery worked |
 * | behind | no successful poll for three intervals |
 * | failing | the server refused sign-in or cannot be reached |
 * | waiting | an inbound-parse mailbox that has not received mail yet |
 */
export const mailboxHealthStateSchema = z.enum(['healthy', 'behind', 'failing', 'waiting']);
export type MailboxHealthState = z.infer<typeof mailboxHealthStateSchema>;

/** Why the last attempt failed: the server said no, or could not be reached. */
export const mailboxErrorKindSchema = z.enum(['auth', 'connect', 'folder']);
export type MailboxErrorKind = z.infer<typeof mailboxErrorKindSchema>;

/** How many poll intervals without a success make a mailbox "Behind". */
export const BEHIND_AFTER_INTERVALS = 3;

export interface MailboxHealthFacts {
  readonly method: MailboxMethod;
  readonly pollIntervalSeconds: number;
  readonly createdAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly lastErrorAt: Date | null;
  readonly lastReceivedAt: Date | null;
}

/**
 * The legend above as a function, so the list and the System page cannot
 * disagree about what "Behind" means. A failure newer than the last success is
 * failing whatever the clock says; an IMAP mailbox that was never polled is
 * measured from when it was created, so a new one gets three intervals of grace.
 */
export const mailboxHealth = (facts: MailboxHealthFacts, now: Date): MailboxHealthState => {
  const { lastSuccessAt, lastErrorAt } = facts;
  if (lastErrorAt !== null && (lastSuccessAt === null || lastErrorAt > lastSuccessAt)) {
    return 'failing';
  }

  if (facts.method === 'inbound_parse') {
    return facts.lastReceivedAt === null ? 'waiting' : 'healthy';
  }

  const since = lastSuccessAt ?? facts.createdAt;
  const behindAfterMs = facts.pollIntervalSeconds * 1_000 * BEHIND_AFTER_INTERVALS;

  return now.getTime() - since.getTime() > behindAfterMs ? 'behind' : 'healthy';
};

const ADDRESS = z.string().trim().toLowerCase().max(254).pipe(z.email());
const HOST = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, 'must be a hostname');
const PORT = z.int().min(1).max(65_535);
const FOLDER = z.string().trim().min(1).max(200);
/** A mail password. Long enough for any app password; never echoed back. */
const PASSWORD = z.string().min(1).max(500);
const ALLOWLIST = z.array(ADDRESS).max(100);

export const mailboxImapSchema = z.object({
  host: z.string(),
  port: z.int(),
  security: mailboxSecuritySchema,
  username: z.string(),
  folder: z.string(),
  pollIntervalSeconds: z.int(),
  /** Whether a password is stored. The password itself never leaves the server. */
  passwordSet: z.boolean(),
  passwordUpdatedAt: z.iso.datetime().nullable(),
  passwordUpdatedByName: z.string().nullable(),
});
export type MailboxImap = z.infer<typeof mailboxImapSchema>;

export const mailboxHealthSchema = z.object({
  state: mailboxHealthStateSchema,
  lastPolledAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastReceivedAt: z.iso.datetime().nullable(),
  /** What the server answered, verbatim. Never contains a credential. */
  lastError: z.string().nullable(),
  lastErrorKind: mailboxErrorKindSchema.nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
});
export type MailboxHealth = z.infer<typeof mailboxHealthSchema>;

/**
 * Why a mailbox action was refused, as a code the Channels screen turns into a
 * sentence (the same idea as `ticketingRefusalSchema`).
 */
export const channelsRefusalSchema = z.enum([
  /** Another mailbox, in this brand or another, already receives for that address. */
  'address-taken',
  /** Switching to IMAP with no password typed and none stored. */
  'password-required',
  /** The department the mailbox would file into is not this brand's. */
  'department-not-found',
]);
export type ChannelsRefusal = z.infer<typeof channelsRefusalSchema>;

export const mailboxSchema = z.object({
  id: z.uuid(),
  address: z.string(),
  displayName: z.string(),
  departmentId: z.uuid(),
  departmentName: z.string(),
  method: mailboxMethodSchema,
  /** Null for an inbound-parse mailbox. */
  imap: mailboxImapSchema.nullable(),
  /** The provider that last delivered to an inbound-parse mailbox. */
  inboundProvider: z.string().nullable(),
  remoteImages: remoteImagePolicySchema,
  authFailureIsSpam: z.boolean(),
  automatedAllowlist: z.array(z.string()),
  health: mailboxHealthSchema,
  createdAt: z.iso.datetime(),
});
export type Mailbox = z.infer<typeof mailboxSchema>;

export const mailboxListSchema = z.object({ mailboxes: z.array(mailboxSchema) });
export type MailboxList = z.infer<typeof mailboxListSchema>;

const imapSettingsRequest = z.object({
  host: HOST,
  port: PORT,
  security: mailboxSecuritySchema,
  username: z.string().trim().min(1).max(254),
  folder: FOLDER.default('INBOX'),
  pollIntervalSeconds: pollIntervalSchema.default(60),
});

const mailboxBase = z.object({
  address: ADDRESS,
  displayName: z.string().trim().min(1).max(120),
  departmentId: z.uuid(),
  remoteImages: remoteImagePolicySchema.default('block'),
  authFailureIsSpam: z.boolean().default(false),
  automatedAllowlist: ALLOWLIST.default([]),
});

/** "Add mailbox". An IMAP mailbox is created with its password; nothing else sets one. */
export const mailboxCreateRequestSchema = z.discriminatedUnion('method', [
  mailboxBase.extend({
    method: z.literal('imap'),
    imap: imapSettingsRequest.extend({ password: PASSWORD }),
  }),
  mailboxBase.extend({ method: z.literal('inbound_parse') }),
]);
export type MailboxCreateRequest = z.infer<typeof mailboxCreateRequestSchema>;

/**
 * "Save mailbox". Every field the form shows, sent whole; `imap.password` only
 * when the person pressed Replace and typed one — absent keeps the stored one.
 * Switching an inbound-parse mailbox to IMAP needs a password, because there is
 * none to keep; the service refuses it without one.
 */
export const mailboxUpdateRequestSchema = z.discriminatedUnion('method', [
  mailboxBase.extend({
    method: z.literal('imap'),
    imap: imapSettingsRequest.extend({ password: PASSWORD.optional() }),
  }),
  mailboxBase.extend({ method: z.literal('inbound_parse') }),
]);
export type MailboxUpdateRequest = z.infer<typeof mailboxUpdateRequestSchema>;

/**
 * "Test IMAP": signs in with the values on screen, saved or not. With a
 * `mailboxId` and no password, the stored password is used, so an Admin can
 * test a saved mailbox without ever seeing its secret.
 */
export const imapTestRequestSchema = imapSettingsRequest
  .omit({ pollIntervalSeconds: true })
  .extend({
    password: PASSWORD.optional(),
    mailboxId: z.uuid().optional(),
  })
  .refine((request) => request.password !== undefined || request.mailboxId !== undefined, {
    message: 'Test IMAP needs a password or a saved mailbox to take it from',
    path: ['password'],
  });
export type ImapTestRequest = z.infer<typeof imapTestRequestSchema>;

/** The three states under Test IMAP, and the fourth the artboard implies (a folder that is not there). */
export const imapTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    host: z.string(),
    port: z.int(),
    folder: z.string(),
    messages: z.int().nonnegative(),
    unseen: z.int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(['auth', 'connect', 'timeout', 'folder']),
    host: z.string(),
    port: z.int(),
    /** The server's own answer, when it gave one. */
    serverResponse: z.string().nullable(),
  }),
]);
export type ImapTestResult = z.infer<typeof imapTestResultSchema>;

// --------------------------------------------------------------------------
// Inbound parse
// --------------------------------------------------------------------------

export const INBOUND_PARSE_PROVIDERS = [
  'postmark',
  'sendgrid',
  'mailgun',
  'resend',
  'generic',
] as const;
export const inboundParseProviderSchema = z.enum(INBOUND_PARSE_PROVIDERS);
export type InboundParseProvider = z.infer<typeof inboundParseProviderSchema>;

/** Where each provider posts. The card lists these under the api's base URL. */
export const inboundParsePath = (provider: InboundParseProvider): string =>
  `/internal/inbound-parse/${provider}`;

export const inboundParseOutcomeSchema = z.enum(['accepted', 'duplicate', 'ignored', 'refused']);
export type InboundParseOutcome = z.infer<typeof inboundParseOutcomeSchema>;

export const inboundParseSettingsSchema = z.object({
  secretSet: z.boolean(),
  secretUpdatedAt: z.iso.datetime().nullable(),
  lastRequest: z
    .object({
      provider: inboundParseProviderSchema,
      at: z.iso.datetime(),
      outcome: inboundParseOutcomeSchema,
    })
    .nullable(),
});
export type InboundParseSettings = z.infer<typeof inboundParseSettingsSchema>;

/** "Replace": the new secret, returned this once and never again. */
export const inboundParseSecretSchema = z.object({ secret: z.string() });
export type InboundParseSecret = z.infer<typeof inboundParseSecretSchema>;

/** The header a provider may send the secret in; HTTP Basic auth's password also works. */
export const INBOUND_PARSE_SECRET_HEADER = 'x-helpdock-inbound-secret';

export const inboundParseProviderParamSchema = z.object({ provider: inboundParseProviderSchema });

const inboundAddressSchema = z.object({
  address: z.string().min(1).max(320),
  name: z.string().max(320).optional(),
});

/**
 * The body `/internal/inbound-parse/generic` accepts: either the raw RFC 5322
 * message, which is parsed exactly as an IMAP one is, or the message already
 * taken apart. Anything that can POST JSON can deliver mail this way.
 */
export const genericInboundEmailSchema = z.union([
  z.object({ raw: z.string().min(1) }),
  z.object({
    from: inboundAddressSchema,
    to: z.array(inboundAddressSchema).min(1).max(100),
    cc: z.array(inboundAddressSchema).max(100).optional(),
    subject: z.string().max(2_000).default(''),
    text: z.string().optional(),
    html: z.string().optional(),
    messageId: z.string().max(998).optional(),
    inReplyTo: z.string().max(998).optional(),
    references: z.array(z.string().max(998)).max(200).optional(),
    date: z.iso.datetime({ offset: true }).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().max(255),
          contentType: z.string().max(255),
          /** Base64 of the bytes. */
          content: z.string(),
          contentId: z.string().max(998).optional(),
          inline: z.boolean().optional(),
        }),
      )
      .max(50)
      .optional(),
  }),
]);
export type GenericInboundEmail = z.infer<typeof genericInboundEmailSchema>;

// --------------------------------------------------------------------------
// The thread's email card
// --------------------------------------------------------------------------

const emailAddressSchema = z.object({ address: z.string(), name: z.string().nullable() });

/**
 * What `ticket_messages.email` holds (M2-04, M2-07). Written once by the
 * inbound pipeline; the remote image URLs stay in it and never reach a client
 * — {@link emailMessageViewSchema} is what does.
 */
export const emailMessageMetaSchema = z.object({
  from: emailAddressSchema,
  to: z.array(emailAddressSchema),
  cc: z.array(emailAddressSchema),
  /** The `Date:` header, when it parsed. The message's own `created_at` is when it arrived. */
  date: z.iso.datetime().nullable(),
  /** The quoted reply stripped from the body, sanitised. "Show quoted text". */
  quotedHtml: z.string().nullable(),
  /** The `<img>`s the body pointed at other servers, removed from `body_html`. */
  remoteImages: z.array(z.object({ url: z.url(), alt: z.string() })),
  /** The receiving mailbox's policy when the message arrived. */
  remoteImagePolicy: remoteImagePolicySchema,
  /** Attachments that were images inside the body (`cid:`), drawn as inline figures. */
  inlineAttachmentIds: z.array(z.uuid()),
  /** An SPF or DKIM failure was reported for it (M2-07). */
  authFailed: z.boolean(),
  /**
   * On the system note of DOMAIN-RULES §4.3: the ticket the sender referenced
   * but is not a participant of.
   */
  mismatch: z.object({ ticketId: z.uuid(), reference: z.string() }).nullable(),
});
export type EmailMessageMeta = z.infer<typeof emailMessageMetaSchema>;

/** The card's part of a thread message: hosts and a count, never the URLs. */
export const emailMessageViewSchema = z.object({
  from: emailAddressSchema,
  to: z.array(emailAddressSchema),
  cc: z.array(emailAddressSchema),
  date: z.iso.datetime().nullable(),
  quotedHtml: z.string().nullable(),
  remoteImages: z.object({
    count: z.int().nonnegative(),
    hosts: z.array(z.string()),
    policy: remoteImagePolicySchema,
  }),
  inlineAttachmentIds: z.array(z.uuid()),
  authFailed: z.boolean(),
  mismatch: z.object({ ticketId: z.uuid(), reference: z.string() }).nullable(),
});
export type EmailMessageView = z.infer<typeof emailMessageViewSchema>;

/** The distinct hosts of the removed images, for "2 from mail.acme.de". */
export const remoteImageHosts = (images: readonly { readonly url: string }[]): string[] => [
  ...new Set(images.map((image) => new URL(image.url).hostname)),
];

export const remoteImageParamSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  messageId: z.uuid(),
  index: z.coerce.number().int().min(0).max(199),
});
export type RemoteImageParam = z.infer<typeof remoteImageParamSchema>;

export const mailboxParamSchema = z.object({ brandId: z.uuid(), mailboxId: z.uuid() });
export type MailboxParam = z.infer<typeof mailboxParamSchema>;

import { z } from 'zod';
import { passwordSchema } from './auth.js';
import { localeSchema } from './brand.js';

/**
 * The first-run wizard (M0-08). One install, four steps: the admin account, the
 * first brand, outgoing email, done.
 *
 * The shapes live here because both halves parse them: `apps/admin` validates
 * each field as it is typed, and `apps/api` declares the same schemas as input
 * DTOs. A rule that only one side knew would be a rule the other side breaks.
 *
 * M7-10 appends the LLM provider step; nothing here assumes there are exactly
 * four.
 */

// --------------------------------------------------------------------------
// Install state
// --------------------------------------------------------------------------

/**
 * Whether this install has been set up. `fresh` means the `users` table is
 * empty and the wizard is the only thing anyone can reach; `configured` means
 * somebody owns it and the wizard is closed for good.
 *
 * It travels as the `helpdock:install-state` meta tag in `index.html` rather
 * than as an endpoint, for the same reason as the other two: an anonymous
 * caller may not interrogate an install (DOMAIN-RULES §1.1).
 */
export const INSTALL_STATES = ['fresh', 'configured'] as const;
export const installStateSchema = z.enum(INSTALL_STATES);
export type InstallState = z.infer<typeof installStateSchema>;

// --------------------------------------------------------------------------
// Field rules shared by the screen and the api
// --------------------------------------------------------------------------

export const TICKET_PREFIX_MIN_LENGTH = 2;
export const TICKET_PREFIX_MAX_LENGTH = 6;

/**
 * `HD` in `HD-1042`. Upper-case letters and digits only, because it is printed
 * in every ticket number, every subject line and every email reference, and it
 * can never be changed once tickets carry it (DOMAIN-RULES §11).
 */
export const TICKET_PREFIX = /^[A-Z0-9]{2,6}$/;
export const ticketPrefixSchema = z
  .string()
  .regex(TICKET_PREFIX, 'must be 2 to 6 characters, A-Z and 0-9');

/** What the hint under the field previews, and what a first ticket will not be. */
export const TICKET_PREVIEW_NUMBER = 1042;

export const ticketNumberPreview = (prefix: string): string =>
  `${prefix || 'HD'}-${String(TICKET_PREVIEW_NUMBER)}`;

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

/**
 * A help-center hostname, stored unverified until M5 checks its TXT record. The
 * same shape `domain-check.ts` accepts, so a domain that passes here is one
 * Caddy can later be told about.
 */
const MAX_DOMAIN_LENGTH = 253;
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const helpcenterDomainSchema = z
  .string()
  .max(MAX_DOMAIN_LENGTH)
  .transform((value) => value.trim().toLowerCase().replace(/\.$/, ''))
  .refine((value) => DOMAIN.test(value), 'must be a hostname such as support.example.com');

// --------------------------------------------------------------------------
// Step 1 — the admin account
// --------------------------------------------------------------------------

export const setupAdminRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  // `passwordSchema`'s twelve characters, and nothing else: composition rules
  // push people towards `Passw0rd!` (M0-06, `ui/password-strength.ts`). The
  // bar on the step is a hint, not a second policy.
  password: passwordSchema,
  locale: localeSchema,
});
export type SetupAdminRequest = z.infer<typeof setupAdminRequestSchema>;

/**
 * The wizard token the remaining steps are presented with. It is returned in
 * the body rather than set as a cookie because it is not a session: it
 * authorises three more calls and then stops existing, and a cookie would
 * outlive the tab that earned it.
 */
export const setupAdminResponseSchema = z.object({
  setupToken: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  admin: z.object({ id: z.uuid(), name: z.string().min(1), email: z.email() }),
});
export type SetupAdminResponse = z.infer<typeof setupAdminResponseSchema>;

// --------------------------------------------------------------------------
// Step 2 — the first brand
// --------------------------------------------------------------------------

export const setupBrandRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prefix: ticketPrefixSchema,
  defaultLocale: localeSchema,
  timezone: timezoneSchema,
  /** Optional, stored unverified; the operator publishes the DNS records later. */
  helpcenterDomain: helpcenterDomainSchema.optional(),
});
export type SetupBrandRequest = z.infer<typeof setupBrandRequestSchema>;

export const setupBrandResponseSchema = z.object({
  brand: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    prefix: z.string().min(1),
    defaultLocale: localeSchema,
    timezone: z.string().min(1),
  }),
  /** Null when no domain was given; never verified at this point. */
  helpcenterDomain: z.string().nullable(),
  /**
   * Whether the brand's default department was created. The wizard says
   * nothing about it on screen; it is here so a client can tell an empty brand
   * from one that was set up.
   */
  departmentCreated: z.boolean(),
});
export type SetupBrandResponse = z.infer<typeof setupBrandResponseSchema>;

// --------------------------------------------------------------------------
// Step 3 — outgoing email
// --------------------------------------------------------------------------

/**
 * How the connection is protected. `tls` is implicit TLS from the first byte
 * (port 465), `starttls` upgrades an unencrypted connection and refuses to
 * continue if the server will not (port 587), and `none` is for a relay on a
 * private network that offers no TLS at all.
 *
 * The settings registry declares the same three values for `smtp.tls`; a unit
 * test in `apps/api/src/install` holds the two together.
 */
export const SMTP_TLS_MODES = ['starttls', 'tls', 'none'] as const;
export const smtpTlsModeSchema = z.enum(SMTP_TLS_MODES);
export type SmtpTlsMode = z.infer<typeof smtpTlsModeSchema>;

export const smtpCredentialsSchema = z.object({
  host: z.string().trim().min(1).max(MAX_DOMAIN_LENGTH),
  port: z.int().min(1).max(65_535),
  tls: smtpTlsModeSchema,
  /** Empty for a relay that does not authenticate. */
  user: z.string().max(320),
  password: z.string().max(512),
  fromAddress: z.email().max(320),
  fromName: z.string().trim().min(1).max(120),
});
export type SmtpCredentials = z.infer<typeof smtpCredentialsSchema>;

/**
 * Saving, or skipping. Skipping is a decision and is recorded as one: the
 * System page's Channels card then says SMTP is not configured, which is the
 * truth an operator has to be able to see later.
 */
export const setupSmtpRequestSchema = z.discriminatedUnion('skip', [
  smtpCredentialsSchema.extend({ skip: z.literal(false) }),
  z.object({ skip: z.literal(true) }),
]);
export type SetupSmtpRequest = z.infer<typeof setupSmtpRequestSchema>;

export const setupSmtpResponseSchema = z.object({ configured: z.boolean() });
export type SetupSmtpResponse = z.infer<typeof setupSmtpResponseSchema>;

/** The test sends with what is on screen, so the credentials travel with it. */
export const smtpTestRequestSchema = smtpCredentialsSchema;
export type SmtpTestRequest = z.infer<typeof smtpTestRequestSchema>;

/**
 * Every way a first SMTP attempt fails, as the screen has to tell them apart.
 * The code picks the catalog key; no server text is ever shown as an error,
 * because a relay's message can quote the address it refused.
 */
const smtpErrorCodes = [
  'auth-failed',
  'connection-refused',
  'tls-error',
  'timeout',
  'rejected',
  'unknown',
] as const;
export const smtpErrorCodeSchema = z.enum(smtpErrorCodes);
export type SmtpErrorCode = z.infer<typeof smtpErrorCodeSchema>;

/** How much of the server's reply is worth showing; the rest is noise in a card. */
export const SMTP_RESPONSE_MAX_LENGTH = 200;

export const smtpTestResultSchema = z.object({
  delivered: z.boolean(),
  /** The server's final reply, truncated. Present only when it delivered. */
  response: z.string().max(SMTP_RESPONSE_MAX_LENGTH).optional(),
  error: smtpErrorCodeSchema.optional(),
});
export type SmtpTestResult = z.infer<typeof smtpTestResultSchema>;

// --------------------------------------------------------------------------
// Step 4 — done
// --------------------------------------------------------------------------

export const setupCompleteResponseSchema = z.object({
  /**
   * When this install requires a second factor, the admin enrols one before
   * anything else; the screen says so and sends them to `/sign-in/enrol`.
   */
  require2fa: z.boolean(),
});
export type SetupCompleteResponse = z.infer<typeof setupCompleteResponseSchema>;

/** The header the wizard presents its token in, on every step after the first. */
export const SETUP_TOKEN_HEADER = 'x-helpdock-setup';

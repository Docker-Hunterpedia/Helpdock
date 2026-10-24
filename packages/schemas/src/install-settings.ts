import { z } from 'zod';
import { MAX_DOMAIN_LENGTH } from './domains.js';
import { smtpTlsModeSchema } from './install.js';

const oauthProviderSettingsSchema = z.strictObject({
  clientId: z.string(),
  clientIdLocked: z.boolean(),
  clientSecretConfigured: z.boolean(),
  clientSecretLocked: z.boolean(),
  enabled: z.boolean(),
});

/**
 * A Google Workspace domain as Google writes the `hd` claim: a lower-case host
 * name with no `@`. The `oauth.google.allowedDomains` setting in
 * `@helpdock/config` stores a list of these (ADR 0051).
 */
export const WORKSPACE_DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const MAX_GOOGLE_ALLOWED_DOMAINS = 20;

/**
 * Google's consumer domains. Their accounts carry no `hd` claim, so listing one
 * would match nobody while looking like it lets Gmail in.
 */
export const GOOGLE_CONSUMER_DOMAINS: readonly string[] = ['gmail.com', 'googlemail.com'];

export const workspaceDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(WORKSPACE_DOMAIN_PATTERN);

/**
 * An Entra directory (tenant) id: a GUID, never a word such as `common` or
 * `organizations` (ADR 0051). `oauth.microsoft.tenantId` stores one, lower-case.
 */
export const MICROSOFT_TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The tenant every personal Microsoft account belongs to. Allowed only by `oauth.microsoft.allowConsumers` (D-52). */
export const MICROSOFT_CONSUMERS_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

export const microsoftTenantIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(MICROSOFT_TENANT_ID_PATTERN, 'The tenant id must be a GUID')
  .refine((id) => id !== MICROSOFT_CONSUMERS_TENANT_ID, {
    message: 'The personal-accounts tenant is not a work or school directory',
  });

const googleSettingsSchema = oauthProviderSettingsSchema.extend({
  /** Empty: any address Google vouches for. Otherwise only Workspace accounts on these. */
  allowedDomains: z.array(z.string().regex(WORKSPACE_DOMAIN_PATTERN)),
  allowedDomainsLocked: z.boolean(),
});

const microsoftSettingsSchema = oauthProviderSettingsSchema.extend({
  /** Empty until set; the provider is off without one. */
  tenantId: z.string(),
  tenantIdLocked: z.boolean(),
  /** Whether personal Microsoft accounts (the consumers tenant) may sign in as well. Off by default. */
  allowConsumers: z.boolean(),
  allowConsumersLocked: z.boolean(),
});

export const installAuthenticationSettingsSchema = z.strictObject({
  requireTwoFactor: z.boolean(),
  requireTwoFactorLocked: z.boolean(),
  magicLinkValidityMinutes: z.int().min(1).max(60),
  magicLinkValidityLocked: z.boolean(),
  google: googleSettingsSchema,
  microsoft: microsoftSettingsSchema,
  github: oauthProviderSettingsSchema,
  redirectUrls: z.strictObject({
    google: z.url(),
    microsoft: z.url(),
    github: z.url(),
  }),
});

const oauthProviderSettingsUpdateSchema = z.strictObject({
  clientId: z.string().trim().max(2_048),
  /** Omitted keeps the sealed value already stored. */
  clientSecret: z.string().min(1).max(4_096).optional(),
});

const googleSettingsUpdateSchema = oauthProviderSettingsUpdateSchema.extend({
  /** Omitted keeps the stored list. Duplicates are dropped. */
  allowedDomains: z
    .array(
      workspaceDomainSchema.refine((domain) => !GOOGLE_CONSUMER_DOMAINS.includes(domain), {
        message:
          'gmail.com and googlemail.com are not Workspace domains; leave the list empty to allow Gmail',
      }),
    )
    .max(MAX_GOOGLE_ALLOWED_DOMAINS)
    .transform((domains) => [...new Set(domains)])
    .optional(),
});

const microsoftSettingsUpdateSchema = oauthProviderSettingsUpdateSchema.extend({
  /** Empty clears it (and turns the provider off); otherwise a GUID. */
  tenantId: z.union([z.literal(''), microsoftTenantIdSchema]),
  /** Omitted keeps the stored value. */
  allowConsumers: z.boolean().optional(),
});

export const installAuthenticationSettingsUpdateSchema = z.strictObject({
  requireTwoFactor: z.boolean(),
  magicLinkValidityMinutes: z.int().min(1).max(60),
  google: googleSettingsUpdateSchema,
  microsoft: microsoftSettingsUpdateSchema,
  github: oauthProviderSettingsUpdateSchema,
});

export type InstallAuthenticationSettings = z.infer<typeof installAuthenticationSettingsSchema>;
export type InstallAuthenticationSettingsUpdate = z.infer<
  typeof installAuthenticationSettingsUpdateSchema
>;

// ---------------------------------------------------------------------------
// Outgoing email (the install's system sender, #369)
// ---------------------------------------------------------------------------

/**
 * Every `smtp.*` key the System page's Outgoing email card shows, with whether
 * an `HD_SMTP_*` variable pins it. A pinned field is drawn locked: the
 * environment wins over the database (ARCHITECTURE §4), so editing it would
 * store a value nothing reads.
 */
const smtpLockedFieldsSchema = z.strictObject({
  host: z.boolean(),
  port: z.boolean(),
  tls: z.boolean(),
  user: z.boolean(),
  password: z.boolean(),
  fromAddress: z.boolean(),
  fromName: z.boolean(),
});

export const smtpSettingsSchema = z.strictObject({
  /** False until a host and a From address exist — the rule `InstallChannels.systemSender` applies. */
  configured: z.boolean(),
  host: z.string(),
  port: z.int().min(1).max(65_535),
  tls: smtpTlsModeSchema,
  /** Empty for a relay that does not authenticate. Never a secret: the wizard stores it in the clear. */
  user: z.string(),
  /** Write-only. The response says whether one is stored, never what it is. */
  passwordConfigured: z.boolean(),
  /** May be empty while unconfigured; stored values were an address when they were saved. */
  fromAddress: z.string(),
  fromName: z.string(),
  locked: smtpLockedFieldsSchema,
});
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

/**
 * Saving the card. The password is optional and means "keep the stored one",
 * so an operator who only came to change the port does not have to retype a
 * credential they cannot see. An empty install takes a password; a save that
 * provides none keeps what is stored.
 */
export const smtpSettingsUpdateSchema = z.strictObject({
  host: z.string().trim().min(1).max(MAX_DOMAIN_LENGTH),
  port: z.int().min(1).max(65_535),
  tls: smtpTlsModeSchema,
  user: z.string().max(320),
  password: z.string().min(1).max(512).optional(),
  fromAddress: z.email().max(320),
  fromName: z.string().trim().min(1).max(120),
});
export type SmtpSettingsUpdate = z.infer<typeof smtpSettingsUpdateSchema>;

/**
 * "Send a test email" sends with what is on screen, so a save is not needed to
 * try a change — the wizard step's own rule. The password travels only when
 * the form holds one; otherwise the stored one is used, and the answer is
 * about the credentials this install would really send with.
 */
export const smtpSettingsTestRequestSchema = smtpSettingsUpdateSchema;
export type SmtpSettingsTestRequest = z.infer<typeof smtpSettingsTestRequestSchema>;

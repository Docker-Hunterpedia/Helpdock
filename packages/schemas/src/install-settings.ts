import { z } from 'zod';

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

const googleSettingsSchema = oauthProviderSettingsSchema.extend({
  /** Empty: any address Google vouches for. Otherwise only Workspace accounts on these. */
  allowedDomains: z.array(z.string().regex(WORKSPACE_DOMAIN_PATTERN)),
  allowedDomainsLocked: z.boolean(),
});

export const installAuthenticationSettingsSchema = z.strictObject({
  requireTwoFactor: z.boolean(),
  requireTwoFactorLocked: z.boolean(),
  magicLinkValidityMinutes: z.int().min(1).max(60),
  magicLinkValidityLocked: z.boolean(),
  google: googleSettingsSchema,
  github: oauthProviderSettingsSchema,
  redirectUrls: z.strictObject({
    google: z.url(),
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

export const installAuthenticationSettingsUpdateSchema = z.strictObject({
  requireTwoFactor: z.boolean(),
  magicLinkValidityMinutes: z.int().min(1).max(60),
  google: googleSettingsUpdateSchema,
  github: oauthProviderSettingsUpdateSchema,
});

export type InstallAuthenticationSettings = z.infer<typeof installAuthenticationSettingsSchema>;
export type InstallAuthenticationSettingsUpdate = z.infer<
  typeof installAuthenticationSettingsUpdateSchema
>;

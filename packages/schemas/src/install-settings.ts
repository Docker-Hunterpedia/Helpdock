import { z } from 'zod';

const oauthProviderSettingsSchema = z.strictObject({
  clientId: z.string(),
  clientIdLocked: z.boolean(),
  clientSecretConfigured: z.boolean(),
  clientSecretLocked: z.boolean(),
  enabled: z.boolean(),
});

export const installAuthenticationSettingsSchema = z.strictObject({
  requireTwoFactor: z.boolean(),
  requireTwoFactorLocked: z.boolean(),
  magicLinkValidityMinutes: z.int().min(1).max(60),
  magicLinkValidityLocked: z.boolean(),
  google: oauthProviderSettingsSchema,
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

export const installAuthenticationSettingsUpdateSchema = z.strictObject({
  requireTwoFactor: z.boolean(),
  magicLinkValidityMinutes: z.int().min(1).max(60),
  google: oauthProviderSettingsUpdateSchema,
  github: oauthProviderSettingsUpdateSchema,
});

export type InstallAuthenticationSettings = z.infer<typeof installAuthenticationSettingsSchema>;
export type InstallAuthenticationSettingsUpdate = z.infer<
  typeof installAuthenticationSettingsUpdateSchema
>;

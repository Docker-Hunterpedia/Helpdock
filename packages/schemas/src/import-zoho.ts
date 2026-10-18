import { z } from 'zod';

const credentialText = z
  .string()
  .min(1)
  .refine((token) =>
    Array.from(token).every(
      (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
    ),
  );

export const zohoCredentialsSchema = z.strictObject({
  region: z.enum(['us', 'eu', 'in', 'au', 'ca', 'jp', 'sa', 'cn', 'sg', 'ae']),
  orgId: z.string().regex(/^[1-9]\d{0,199}$/),
  clientId: credentialText.max(4096),
  clientSecret: credentialText.max(8192),
  refreshToken: credentialText.max(8192),
});
export type ZohoCredentials = z.infer<typeof zohoCredentialsSchema>;

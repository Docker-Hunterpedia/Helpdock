import { z } from 'zod';

const endpoint = z.url().refine((raw) => {
  const url = new URL(raw);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, 'An identity endpoint must be HTTP(S) without credentials or a fragment');
const role = z.enum(['admin', 'team_leader', 'agent', 'viewer']);
export const ssoAccessSchema = z
  .object({
    brandId: z.uuid(),
    role,
    departmentIds: z.array(z.uuid()).max(100).nullable(),
  })
  .refine(
    (access) => access.role !== 'agent' || access.departmentIds !== null,
    'Agents require an explicit department list',
  );

export const ssoConnectionConfigSchema = z.discriminatedUnion('protocol', [
  z.object({
    protocol: z.literal('oidc'),
    issuer: endpoint,
    clientId: z.string().trim().min(1).max(300),
    scopes: z
      .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/))
      .min(1)
      .max(30)
      .default(['openid', 'email', 'profile'])
      .refine((scopes) => scopes.includes('openid')),
    emailClaim: z.string().min(1).max(200).default('email'),
    nameClaim: z.string().min(1).max(200).default('name'),
    requireEmailVerified: z.literal(true).default(true),
  }),
  z.object({
    protocol: z.literal('saml'),
    idpEntityId: z.string().min(1).max(2000),
    idpSsoUrl: endpoint,
    idpCertificates: z.array(z.string().min(1).max(16000)).min(1).max(3),
    idpMetadataUrl: endpoint.optional(),
    nameIdFormat: z.enum(['emailAddress', 'persistent', 'unspecified']).default('persistent'),
    emailAttribute: z.string().min(1).max(200).optional(),
    nameAttribute: z.string().min(1).max(200).optional(),
    signAuthnRequests: z.literal(true).default(true),
    allowIdpInitiated: z.boolean().default(false),
    clockSkewSeconds: z.int().min(0).max(60).default(60),
  }),
]);
const connectionFields = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(false),
  emailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    )
    .max(100)
    .default([]),
  jitEnabled: z.boolean().default(true),
  idpEnforcesMfa: z.boolean().default(false),
  defaultAccess: ssoAccessSchema.nullable().default(null),
  groupAttribute: z.string().trim().min(1).max(200).nullable().default(null),
  config: ssoConnectionConfigSchema,
  clientSecret: z.string().min(1).max(16000).optional(),
});
export const ssoConnectionCreateSchema = connectionFields.refine(
  (connection) => connection.config.protocol === 'oidc' || connection.clientSecret === undefined,
  'Only OIDC connections accept a client secret',
);
// Updates replace the public configuration; an omitted secret retains the stored value.
export const ssoConnectionUpdateSchema = ssoConnectionCreateSchema;
export const ssoConnectionSchema = connectionFields.omit({ clientSecret: true }).extend({
  id: z.uuid(),
  protocol: z.enum(['oidc', 'saml']),
  secretConfigured: z.boolean(),
  lastSignInAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const ssoConnectionListSchema = z.object({ connections: z.array(ssoConnectionSchema) });
export const ssoConnectionDetailSchema = ssoConnectionSchema.extend({
  sp: z.object({
    entityId: z.url(),
    acsUrl: z.url(),
    metadataUrl: z.url(),
    oidcRedirectUri: z.url(),
  }),
});
export const ssoMappingSchema = ssoAccessSchema.safeExtend({
  idpGroup: z.string().min(1).max(300),
  position: z.int().min(0).max(1000),
});
export const ssoMappingsSchema = z
  .object({ mappings: z.array(ssoMappingSchema).max(1000) })
  .refine(
    ({ mappings }) =>
      new Set(mappings.map((mapping) => `${mapping.brandId}:${mapping.position}`)).size ===
      mappings.length,
    'Mapping positions must be unique within each brand',
  );
export const ssoSettingsUpdateSchema = z
  .object({
    enforced: z.boolean(),
    breakGlassUserIds: z
      .array(z.uuid())
      .max(3)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine(
    (settings) => !settings.enforced || settings.breakGlassUserIds.length > 0,
    'Enforcement requires a break-glass administrator',
  );
export const ssoSettingsSchema = ssoSettingsUpdateSchema.safeExtend({
  enforcedLocked: z.boolean(),
  breakGlassLocked: z.boolean(),
});
export const ssoConnectionParamSchema = z.object({ id: z.uuid() });
export type SsoConnectionInput = z.infer<typeof ssoConnectionCreateSchema>;
export type SsoConnection = z.infer<typeof ssoConnectionSchema>;
export type SsoMapping = z.infer<typeof ssoMappingSchema>;
export type SsoSettingsUpdate = z.infer<typeof ssoSettingsUpdateSchema>;

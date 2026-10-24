import { z } from 'zod';

const endpoint = z.url().refine((raw) => {
  try {
    const url = new URL(raw);
    return (
      ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
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
export const ssoConnectionCreateSchema = connectionFields
  .refine(
    (connection) => connection.config.protocol === 'oidc' || connection.clientSecret === undefined,
    'Only OIDC connections accept a client secret',
  )
  // A preset's `{tenant-id}` template is a URL the parser accepts but no provider
  // serves. Only input is refused: stored rows still parse through the config schema.
  .refine(
    (connection) => connection.config.protocol !== 'oidc' || !/[{}]/.test(connection.config.issuer),
    { message: 'Replace the template placeholder in the issuer', path: ['config', 'issuer'] },
  );
// Updates replace the public configuration; an omitted secret retains the stored value.
export const ssoConnectionUpdateSchema = ssoConnectionCreateSchema;
export const ssoConnectionSchema = connectionFields.omit({ clientSecret: true }).extend({
  id: z.uuid(),
  protocol: z.enum(['oidc', 'saml']),
  secretConfigured: z.boolean(),
  peopleCount: z.int().nonnegative().default(0),
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

/** A connection save refused by a rule the form can explain (M11, issue #219). */
export const ssoRefusalSchema = z.enum([
  /** Another enabled connection lists one of these email domains. */
  'sso-email-domain-taken',
  /** The IdP metadata lists a signing certificate the admin has not saved. */
  'sso-metadata-confirm-certificates',
  /** The issuer changed and the stored client secret was not typed again. */
  'sso-client-secret-required',
]);
export type SsoRefusal = z.infer<typeof ssoRefusalSchema>;
export type SsoConnectionInput = z.infer<typeof ssoConnectionCreateSchema>;
export type SsoConnection = z.infer<typeof ssoConnectionSchema>;
export type SsoMapping = z.infer<typeof ssoMappingSchema>;
export type SsoSettingsUpdate = z.infer<typeof ssoSettingsUpdateSchema>;

export const ssoDiscoveryRequestSchema = z.object({ email: z.email().max(320) });
export const ssoDiscoveryResponseSchema = z.object({
  connections: z.array(z.object({ id: z.uuid(), name: z.string().min(1).max(80) })),
});

export const ssoTestStartSchema = z.object({ startUrl: z.url() });
export const ssoTestResultSchema = z.object({
  claims: z.object({
    subject: z.string().min(1).max(300),
    email: z.email(),
    name: z.string().max(300).optional(),
    groups: z.array(z.string().max(300)).max(1000),
  }),
  user: z.object({ id: z.uuid(), name: z.string(), email: z.email() }).nullable(),
  wouldCreate: z.boolean(),
  access: z.array(ssoAccessSchema),
  conflict: z.boolean(),
});
export const ssoTestKeySchema = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const ssoTargetsSchema = z.object({
  sp: z.object({ entityId: z.url(), metadataUrl: z.url() }),
  brands: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      departments: z.array(z.object({ id: z.uuid(), name: z.string() })),
    }),
  ),
  admins: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.email(),
      eligible: z.boolean(),
      /** Ineligible only because every passkey registered without user verification. */
      passkeyNeedsVerification: z.boolean().default(false),
    }),
  ),
});
export type SsoTargets = z.infer<typeof ssoTargetsSchema>;
export type SsoConnectionDetail = z.infer<typeof ssoConnectionDetailSchema>;
export type SsoSettings = z.infer<typeof ssoSettingsSchema>;
export type SsoTestResult = z.infer<typeof ssoTestResultSchema>;

export const ssoReturnToSchema = z
  .string()
  .max(2000)
  .default('/')
  .refine((path) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in redirect targets.
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path))
      return false;
    try {
      const decoded = decodeURIComponent(path);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject encoded control characters too.
      return !decoded.startsWith('//') && !/[\\\u0000-\u001f]/.test(decoded);
    } catch {
      return false;
    }
  }, 'Return path must stay on this installation');

/** The settings form saves connection and mapping changes in one transaction. */
export const ssoConfigurationSchema = z
  .object({ connection: ssoConnectionCreateSchema })
  .and(ssoMappingsSchema);
export type SsoConfiguration = z.infer<typeof ssoConfigurationSchema>;

export const ssoCertificatesSchema = z.object({
  certificates: z.array(z.string().min(1).max(16000)).min(1).max(3),
});
export const ssoCertificateDetailsSchema = z.object({
  certificates: z
    .array(
      z.object({
        subject: z.string().max(2000),
        fingerprint: z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/),
        expiresAt: z.iso.datetime(),
      }),
    )
    .max(3),
});
export type SsoCertificateDetails = z.infer<typeof ssoCertificateDetailsSchema>;

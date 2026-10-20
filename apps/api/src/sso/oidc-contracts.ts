import { ssoReturnToSchema } from '@helpdock/schemas';

export { ssoReturnToSchema } from '@helpdock/schemas';

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cookieAttributes } from '../auth/session/cookies.js';
import { SSO_REQUEST_TTL_SECONDS } from './request-store.js';

export const ssoAssertionSchema = z.object({
  connectionId: z.uuid(),
  connectionRevision: z.iso.datetime().optional(),
  subject: z.string().min(1).max(300),
  email: z.email(),
  /** Whether the provider vouched for `email`; only a verified address may link or provision. */
  emailVerified: z.boolean(),
  name: z.string().max(300).optional(),
  groups: z.array(z.string().min(1).max(300)).max(1000),
});
export type SsoAssertion = z.infer<typeof ssoAssertionSchema>;

export const oidcStartQuerySchema = z.object({
  returnTo: ssoReturnToSchema,
  test: z.literal('0').optional(),
});
export const oidcCallbackQuerySchema = z.object({
  state: z.string().min(16).max(256),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(200).optional(),
  iss: z.string().max(2000).optional(),
});
export const oidcRequestSchema = z.object({
  connectionId: z.uuid(),
  configurationHash: z.string().length(64),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(32).max(256),
  browserNonceHash: z.string().length(64),
  returnTo: ssoReturnToSchema,
});

export const ssoHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function matchesBrowserNonce(nonce: string | undefined, expected: string): boolean {
  if (nonce === undefined || nonce.length > 256) return false;
  const actual = Buffer.from(ssoHash(nonce));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export class OidcFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OidcFailure';
  }
}

/**
 * A single-tenant Entra ID v2.0 issuer. The tenant must be a GUID: `common`,
 * `organizations` and `consumers` accept accounts from any tenant.
 */
const ENTRA_TENANT_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;
/** The personal Microsoft account tenant: its users choose their own addresses. */
const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/**
 * Entra ID never sends `email_verified`. Its `xms_edov` says the address's
 * domain is verified by the tenant that holds the account, which counts only
 * from the one tenant the connection names (M18-09).
 */
function entraVouchesForEmail(issuer: string, claims: Record<string, unknown>): boolean {
  const tenant = ENTRA_TENANT_ISSUER.exec(issuer)?.[1];
  return (
    tenant !== undefined &&
    tenant !== MICROSOFT_CONSUMER_TENANT &&
    claims.iss === issuer &&
    claims.tid === tenant &&
    claims.xms_edov === true
  );
}

export function oidcAssertion(input: {
  connectionId: string;
  /** The connection's configured issuer, which the ID token's `iss` already matched. */
  issuer: string;
  claims: Record<string, unknown>;
  supplemental: Record<string, unknown>;
  emailClaim: string;
  nameClaim: string;
  groupAttribute: string | null;
}): SsoAssertion {
  const { claims, supplemental, groupAttribute } = input;
  // Supplementary UserInfo never establishes the address or its verification.
  const email = claims[input.emailClaim];
  if (typeof email !== 'string') throw new OidcFailure('sso-email-unverified');
  // Entra overage is unknown membership, not an empty authoritative list.
  const sources = claims._claim_names;
  if (
    groupAttribute &&
    (claims.hasgroups === true ||
      (sources && typeof sources === 'object' && Object.hasOwn(sources, groupAttribute)))
  ) {
    throw new OidcFailure('sso-groups-unavailable');
  }
  const groups =
    groupAttribute === null ? [] : (claims[groupAttribute] ?? supplemental[groupAttribute]);
  if (groups === undefined) throw new OidcFailure('sso-groups-unavailable');
  return ssoAssertionSchema.parse({
    connectionId: input.connectionId,
    subject: claims.sub,
    email,
    // `email_verified` speaks only for the `email` claim, never for an
    // administrator-chosen claim such as `upn`, which can hold any address.
    emailVerified:
      input.emailClaim === 'email' &&
      (claims.email_verified === true || entraVouchesForEmail(input.issuer, claims)),
    name: claims[input.nameClaim] ?? supplemental[input.nameClaim],
    groups: typeof groups === 'string' ? [groups] : groups,
  });
}

export function oidcNonceCookie(appUrl: string, connectionId: string) {
  const attributes = cookieAttributes({ appUrl, maxAgeSeconds: SSO_REQUEST_TTL_SECONDS });
  // HTTPS uses the browser's host-prefix enforcement to prevent sibling-domain
  // cookie planting. That prefix requires Path=/; HTTP is a local-dev exception.
  return {
    name: `${attributes.secure ? '__Host-' : ''}hd_sso_${connectionId}`,
    attributes: { ...attributes, path: attributes.secure ? '/' : `/api/auth/sso/${connectionId}` },
  };
}

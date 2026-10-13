import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const ssoAssertionSchema = z.object({
  connectionId: z.uuid(),
  subject: z.string().min(1).max(1000),
  email: z.email(),
  emailVerified: z.literal(true),
  name: z.string().max(300).optional(),
  groups: z.array(z.string().min(1).max(300)).max(1000),
});
export type SsoAssertion = z.infer<typeof ssoAssertionSchema>;

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

export function oidcAssertion(input: {
  connectionId: string;
  claims: Record<string, unknown>;
  supplemental: Record<string, unknown>;
  emailClaim: string;
  nameClaim: string;
  groupAttribute: string | null;
}): SsoAssertion {
  const { claims, supplemental, groupAttribute } = input;
  if (claims.email_verified !== true) throw new OidcFailure('sso-email-unverified');
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
    // Supplementary UserInfo never establishes the address or its verification.
    email: claims[input.emailClaim],
    emailVerified: true,
    name: claims[input.nameClaim] ?? supplemental[input.nameClaim],
    groups: typeof groups === 'string' ? [groups] : groups,
  });
}

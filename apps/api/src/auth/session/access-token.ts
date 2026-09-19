import type { BrandMembership, SessionClaims } from '@helpdock/schemas';
import { sessionClaimsSchema } from '@helpdock/schemas';
import { jwtVerify, SignJWT } from 'jose';
import { SIGNING_ALGORITHM, type SigningKeys } from './signing-keys.js';

/**
 * The access token of ARCHITECTURE §7: a JWS the api signs with ES256 and
 * verifies on every request, carrying everything the permission guard needs.
 *
 * Ten minutes, and no database read to verify one. That pair is the whole
 * design: claims can go stale, so nothing that must be immediate may live in
 * them, and everything that must be immediate — revocation — is a separate,
 * cheap Redis check (DOMAIN-RULES §1.6 allows the ten minutes explicitly).
 */

/** Seconds. DOMAIN-RULES §1.6: "an existing access token keeps working for at most 10 minutes". */
export const ACCESS_TOKEN_TTL_SECONDS = 600;

export interface IssueAccessTokenInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly brands: Readonly<Record<string, BrandMembership>>;
  readonly installAdmin: boolean;
}

export const issueAccessToken = async (
  input: IssueAccessTokenInput,
  keys: SigningKeys,
): Promise<string> =>
  new SignJWT({
    sid: input.sessionId,
    fam: input.familyId,
    brands: input.brands,
    installAdmin: input.installAdmin,
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: keys.kid, typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(keys.privateKey);

/**
 * The claims, or `null` for anything that is not a token this install signed
 * and that is still in date.
 *
 * `algorithms` is pinned to ES256: without it, a token whose header names
 * `none`, or a symmetric algorithm keyed with the public key, would be a way in.
 * The caller learns nothing about *why* a token failed, because a caller with a
 * bad token has no business being told.
 */
export const verifyAccessToken = async (
  token: string,
  keys: SigningKeys,
): Promise<SessionClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      algorithms: [SIGNING_ALGORITHM],
    });

    const parsed = sessionClaimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** `Bearer <token>`, case-insensitively, or `null`. */
export const bearerTokenOf = (header: string | string[] | undefined): string | null => {
  if (typeof header !== 'string') {
    return null;
  }

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1) {
    return null;
  }

  const token = rest[0]?.trim() ?? '';
  return token === '' ? null : token;
};

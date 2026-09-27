import { randomBytes } from 'node:crypto';
import type { HcLocale } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { SIGNING_ALGORITHM, type SigningKeys } from '../../auth/session/signing-keys.js';

/**
 * Reading the help center as staff (M5-03, DOMAIN-RULES §5): the internal
 * audience applies only to a request that carries a live staff session of the
 * brand. The admin's session cannot simply be sent along — its access token
 * lives in the admin's memory and its refresh cookie is host-only on the
 * install's host, path `/api/auth` — and the help center is usually on the
 * brand's own domain. So the session is carried across in two steps:
 *
 * 1. **A staff pass.** The admin, signed in, asks
 *    `POST /api/brands/:brandId/help-center/staff-pass`; the api checks the
 *    bearer token like any other request, and stores a random one-time pass
 *    in Redis for {@link PASS_TTL_SECONDS}, naming the person, their refresh
 *    family, the brand and where to land.
 * 2. **A staff cookie on the help center's host.** The browser opens
 *    `<help center>/_hd/staff?pass=…`; the pass is spent (`GETDEL`), and the
 *    answer sets `hd_hc_staff`, a JWS signed with the install's session key
 *    (ADR 0015), then redirects to the page asked for.
 *
 * Every page request checks the cookie's signature, its brand, and that its
 * **refresh family is still alive** in the same store sign-out, "sign out
 * everywhere", a password reset and a role change revoke (`refresh-store.ts`).
 * So signing out of the admin ends the help center session on the next page,
 * not when the cookie expires. Redis unreachable counts as signed out.
 */

export const STAFF_COOKIE = 'hd_hc_staff';
export const PASS_TTL_SECONDS = 60;
/** A working day. The family check, not this, is what ends a session early. */
export const STAFF_COOKIE_TTL_SECONDS = 8 * 60 * 60;
const AUDIENCE = 'helpdock:help-center';
const PASS_PREFIX = 'hc:staff-pass:';

export interface StaffPass {
  readonly staffId: string;
  readonly familyId: string;
  readonly name: string;
  readonly brandId: string;
  /** A path on the help center, below its base. */
  readonly path: string;
}

export interface StaffReader {
  readonly staffId: string;
  readonly name: string;
}

const passSchema = z.object({
  staffId: z.uuid(),
  familyId: z.string().min(1),
  name: z.string(),
  brandId: z.uuid(),
  path: z.string().startsWith('/'),
});

const cookieClaimsSchema = z.object({
  sub: z.uuid(),
  fam: z.string().min(1),
  brand: z.uuid(),
  name: z.string(),
});

/** What the family check needs of `RefreshStore`. */
export interface FamilyLookup {
  userOfFamily(familyId: string): Promise<string | null>;
}

export class StaffAccess {
  readonly #redis: Redis;
  readonly #keys: SigningKeys;
  readonly #families: FamilyLookup;

  constructor(options: { redis: Redis; keys: SigningKeys; families: FamilyLookup }) {
    this.#redis = options.redis;
    this.#keys = options.keys;
    this.#families = options.families;
  }

  /** Stores a one-time pass and answers its token. */
  async issuePass(pass: StaffPass): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.#redis.set(
      `${PASS_PREFIX}${token}`,
      JSON.stringify(passSchema.parse(pass)),
      'EX',
      PASS_TTL_SECONDS,
    );
    return token;
  }

  /** Spends a pass. Null for one that is unknown, used or expired. */
  async spendPass(token: string): Promise<StaffPass | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      return null;
    }
    const stored = await this.#redis.getdel(`${PASS_PREFIX}${token}`);
    if (stored === null) {
      return null;
    }
    try {
      const parsed = passSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** The cookie value for a spent pass. */
  cookieFor(pass: StaffPass): Promise<string> {
    return new SignJWT({ fam: pass.familyId, brand: pass.brandId, name: pass.name })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: this.#keys.kid, typ: 'JWT' })
      .setSubject(pass.staffId)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${STAFF_COOKIE_TTL_SECONDS}s`)
      .sign(this.#keys.privateKey);
  }

  /**
   * The staff member this cookie signs in on this brand's help center, or
   * null: no cookie, a bad or expired one, another brand's, or a session that
   * has since ended.
   */
  async readerOf(cookie: string | undefined, brandId: string): Promise<StaffReader | null> {
    if (cookie === undefined || cookie === '') {
      return null;
    }
    let claims: z.infer<typeof cookieClaimsSchema>;
    try {
      const { payload } = await jwtVerify(cookie, this.#keys.publicKey, {
        algorithms: [SIGNING_ALGORITHM],
        audience: AUDIENCE,
      });
      const parsed = cookieClaimsSchema.safeParse(payload);
      if (!parsed.success) {
        return null;
      }
      claims = parsed.data;
    } catch {
      return null;
    }
    if (claims.brand !== brandId) {
      return null;
    }
    try {
      if ((await this.#families.userOfFamily(claims.fam)) !== claims.sub) {
        return null;
      }
    } catch {
      return null;
    }
    return { staffId: claims.sub, name: claims.name };
  }
}

/** Where a pass for the editor's Preview lands. */
export const previewPath = (locale: HcLocale, slug: string): string =>
  `/${locale}/articles/${slug}?preview=1`;

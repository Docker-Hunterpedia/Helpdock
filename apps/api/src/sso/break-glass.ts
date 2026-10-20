import { type Db, type DbTransaction, type User, webauthnCredentials } from '@helpdock/db';
import { inArray, sql } from 'drizzle-orm';

/**
 * The single source of truth for what SSO enforcement allows (ADR 0026 (10),
 * amended by ADR 0053). Every local path asks here, so a factor cannot be
 * allowed in one place and refused in another.
 */

/**
 * Whether a sign-in that began with `firstFactor` may finish with `second`
 * (`totp`, `passkey`, `recovery-code`, `trusted-browser`, or the audit names
 * `idp` and `passkey-uv`; `null` is no second factor)
 * while SSO is enforced.
 *
 * - After an SSO assertion the IdP is the first factor, so an app code or a
 *   passkey is a fair second one (or none). Recovery codes and trusted
 *   browsers are skipped, as they are for break-glass.
 * - After a password (break-glass) the second factor is a fresh code or a
 *   passkey assertion with user verification. Nothing else qualifies: a sign-in
 *   with no second factor, a recovery code or a trusted browser is refused.
 * - Every other first factor (magic link, OAuth, a passkey on its own) is
 *   refused outright.
 */
export const enforcementAllows = (firstFactor: string, second: string | null): boolean => {
  if (firstFactor === 'sso') return second !== 'recovery-code' && second !== 'trusted-browser';
  if (firstFactor === 'password') return second === 'totp' || second === 'passkey';
  return false;
};

type BreakGlassCandidate = Pick<
  User,
  'installAdmin' | 'status' | 'passwordHash' | 'totpEnabled' | 'totpSecretEncrypted'
>;

/** An active install admin with a password and (an authenticator app or a passkey). */
export const isBreakGlassEligible = (user: BreakGlassCandidate, passkeyCount: number): boolean =>
  user.installAdmin &&
  user.status === 'active' &&
  user.passwordHash !== null &&
  ((user.totpEnabled && user.totpSecretEncrypted !== null) || passkeyCount > 0);

/** Passkeys held per account, for the ids given (accounts with none are absent). */
export const passkeyCounts = async (
  tx: Db | DbTransaction,
  userIds: readonly string[],
): Promise<Map<string, number>> => {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select({
      userId: webauthnCredentials.userId,
      held: sql<number>`count(*)::int`,
    })
    .from(webauthnCredentials)
    .where(inArray(webauthnCredentials.userId, [...userIds]))
    .groupBy(webauthnCredentials.userId);
  return new Map(rows.map((row) => [row.userId, row.held]));
};

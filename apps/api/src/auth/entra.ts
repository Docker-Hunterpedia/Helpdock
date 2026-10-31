import { MICROSOFT_CONSUMERS_TENANT_ID } from '@helpdock/schemas';

/**
 * The one rule for when Entra ID vouches for an address, shared by the staff
 * SSO OIDC preset (M18-09) and the Microsoft sign-in button (M18-08), so the
 * two can never drift.
 */

/**
 * A single-tenant Entra ID v2.0 issuer in the global cloud. The tenant must be
 * a GUID: `common`, `organizations` and `consumers` accept accounts from any
 * tenant. Government and China cloud hosts never match, so they fail closed.
 */
const ENTRA_TENANT_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/;

/**
 * Entra ID never sends `email_verified`. Its `xms_edov` says the domain of the
 * address is verified by the tenant that holds the account. For a guest that is
 * the guest's home tenant, or a personal Microsoft, Google or one-time-passcode
 * account, so it counts only for a member (`acct` 0) of the one tenant `issuer`
 * names: then that tenant is the one vouching. Personal accounts choose their
 * own addresses and are never vouched for. Only the JSON boolean `true` and
 * the number `0` count; a string never does.
 *
 * A B2B user made a member (for example by cross-tenant synchronisation) has
 * `acct` 0 while its `xms_edov` speaks for its home tenant. Microsoft sets
 * `idp` to the issuer unless the account lives in another tenant, so `idp`, when
 * present, must name the pinned tenant too.
 */
export function entraVouchesForEmail(issuer: string, claims: Record<string, unknown>): boolean {
  const tenant = ENTRA_TENANT_ISSUER.exec(issuer)?.[1];
  return (
    tenant !== undefined &&
    tenant !== MICROSOFT_CONSUMERS_TENANT_ID &&
    claims.iss === issuer &&
    claims.tid === tenant &&
    claims.acct === 0 &&
    claims.xms_edov === true &&
    identityProviderIsTenant(claims.idp, issuer, tenant)
  );
}

function identityProviderIsTenant(idp: unknown, issuer: string, tenant: string): boolean {
  return idp === undefined || idp === issuer || idp === `https://sts.windows.net/${tenant}/`;
}

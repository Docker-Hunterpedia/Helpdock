import { ssoConnectionConfigSchema } from '@helpdock/schemas';

/** Certificates and endpoint rotation do not change the account namespace; issuer/client or NameID changes do. */
export function ssoIdentityAuthority(config: unknown): string {
  const parsed = ssoConnectionConfigSchema.parse(config);
  return JSON.stringify(
    parsed.protocol === 'oidc'
      ? [parsed.protocol, parsed.issuer, parsed.clientId]
      : [parsed.protocol, parsed.idpEntityId, parsed.nameIdFormat],
  );
}

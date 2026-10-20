import { isIP } from 'node:net';

/** The relying party name an authenticator shows beside the account. */
export const RELYING_PARTY_NAME = 'Helpdock';

export interface RelyingParty {
  /** The RP ID: `APP_URL`'s host name. */
  readonly id: string;
  /** The one origin an assertion may come from: `APP_URL`'s origin. */
  readonly origin: string;
}

/**
 * The relying party this install is, derived from `APP_URL` and nothing else
 * (ADR 0050). Never from a `Host` or `Origin` header: behind a proxy those are
 * whatever the client sent, and an RP ID taken from them would let a lookalike
 * host mint ceremonies for itself.
 *
 * Null when browsers will not run WebAuthn there. They need a secure context,
 * which is https, or plain http on `localhost` while developing; and an RP ID
 * is a domain, so an install reached by IP address has no passkeys either.
 */
export const relyingPartyFor = (appUrl: string): RelyingParty | null => {
  const url = new URL(appUrl);
  const host = url.hostname;
  const isLocalhost = host === 'localhost';

  if (url.protocol === 'http:' && !isLocalhost) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  // `URL` keeps the brackets around an IPv6 literal.
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) {
    return null;
  }

  return { id: host, origin: url.origin };
};

import { isIP } from 'node:net';
import { settingDefinitions } from '@helpdock/config';

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
 * Nor does a host the `auth.webauthn.rpId` setting could not hold (an
 * underscore, a trailing dot): the RP ID is pinned there, and a host that
 * cannot be pinned cannot be compared with the pin.
 */
export const relyingPartyFor = (appUrl: string): RelyingParty | null => {
  const url = new URL(appUrl);
  const host = url.hostname;
  const secureContext =
    url.protocol === 'https:' || (url.protocol === 'http:' && host === 'localhost');
  if (!secureContext) {
    return null;
  }
  const pinnable =
    host !== '' && settingDefinitions['auth.webauthn.rpId'].schema.safeParse(host).success;
  // An IPv6 literal already fails the pattern (brackets, colons); an IPv4 one does not.
  if (!pinnable || isIP(host) !== 0) {
    return null;
  }

  return { id: host, origin: url.origin };
};

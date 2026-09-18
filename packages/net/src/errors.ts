/**
 * Failure modes of {@link safeFetch}, from DOMAIN-RULES §13.
 *
 * `destination-blocked` is the first hop failing a range check; `redirect-blocked`
 * is any later hop failing any check, with the underlying reason in `reason`.
 */
export type SafeFetchErrorCode =
  | 'invalid-url'
  | 'scheme-not-allowed'
  | 'credentials-in-url'
  | 'port-not-allowed'
  | 'dns-failure'
  | 'destination-blocked'
  | 'too-many-redirects'
  | 'redirect-blocked'
  | 'timeout'
  | 'body-too-large'
  | 'network-error';

export interface SafeFetchErrorDetails {
  /** The URL of the hop that failed, as far as it could be parsed. */
  readonly url: string | undefined;
  /** Hostname of the hop that failed. */
  readonly host: string | undefined;
  /** Resolved address the hop was rejected on, when the failure was an address check. */
  readonly address: string | undefined;
  /** Redirect hop index: 0 is the URL the caller passed in. */
  readonly hop: number;
  /** For `redirect-blocked`, the code of the check the hop failed. */
  readonly reason: SafeFetchErrorCode | undefined;
}

/**
 * The only error {@link safeFetch} throws for a request outcome. It carries the
 * destination so a blocked attempt can be logged (DOMAIN-RULES §13) and never
 * carries any part of the response body.
 */
export class SafeFetchError extends Error implements SafeFetchErrorDetails {
  readonly code: SafeFetchErrorCode;
  readonly url: string | undefined;
  readonly host: string | undefined;
  readonly address: string | undefined;
  readonly hop: number;
  readonly reason: SafeFetchErrorCode | undefined;

  constructor(
    code: SafeFetchErrorCode,
    message: string,
    details: Partial<SafeFetchErrorDetails> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'SafeFetchError';
    this.code = code;
    this.url = details.url;
    this.host = details.host;
    this.address = details.address;
    this.hop = details.hop ?? 0;
    this.reason = details.reason;
  }
}

/**
 * Wraps a hop failure as `redirect-blocked` so callers can tell "the URL you gave
 * me was rejected" from "hop 3 of the redirect chain was rejected", without
 * losing the original reason.
 */
export function asRedirectBlocked(error: SafeFetchError): SafeFetchError {
  return new SafeFetchError(
    'redirect-blocked',
    `redirect hop ${error.hop} blocked: ${error.message}`,
    {
      url: error.url,
      host: error.host,
      address: error.address,
      hop: error.hop,
      reason: error.code,
    },
    { cause: error },
  );
}

export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Import paused by vendor rate limit');
    this.name = 'RateLimited';
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1)
      throw new RangeError('Retry delay must be a positive safe integer');
  }
}

/** Safe keys only: provider response bodies and credential-bearing URLs never become import log text. */
export class ConnectorError extends Error {
  constructor(
    readonly code:
      | 'credentials-refused'
      | 'vendor-unavailable'
      | 'invalid-response'
      | 'record-unavailable',
    readonly status?: number,
  ) {
    super(code);
    this.name = 'ConnectorError';
  }
}

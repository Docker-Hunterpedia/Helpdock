import { uuidv7 } from '@helpdock/db';

/**
 * A request id is a correlation key that ends up in every log line and in the
 * body of a 500. A client may propose one, but only through a proxy the install
 * controls: otherwise anyone could pick the id an operator greps for, or write
 * newlines into the log stream.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

const MAX_LENGTH = 128;
// Wide enough for a UUID, a W3C trace id and the ids Caddy and nginx generate,
// narrow enough that nothing in it can end a JSON string or a log line.
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

/** Whether a proposed id may be used as-is. */
export const isUsableRequestId = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_LENGTH && SAFE_ID.test(value);

/**
 * The id for this request: the one the proxy passed when `TRUST_PROXY` is on
 * and the value is safe, a fresh UUIDv7 otherwise. UUIDv7 rather than v4 so ids
 * sort by time, which is what makes them useful in a log.
 */
export const resolveRequestId = (
  header: string | string[] | undefined,
  { trustProxy }: { readonly trustProxy: boolean },
): string => {
  if (!trustProxy) {
    return uuidv7();
  }

  // A duplicated header arrives as an array; only one value can be the id, and
  // choosing one of several would let a client smuggle a second in.
  const proposed = typeof header === 'string' ? header.trim() : undefined;
  return proposed !== undefined && isUsableRequestId(proposed) ? proposed : uuidv7();
};

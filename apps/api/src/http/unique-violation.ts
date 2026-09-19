import { ZodError } from 'zod';

/**
 * Postgres refusing a duplicate, turned into the answer a form can draw.
 *
 * It is shared because both paths that create a brand hit the same unique index
 * on `brands.prefix` — the first-run wizard and `POST /api/install/brands` —
 * and a second copy of "how Drizzle wraps a driver error" is a second place to
 * get it wrong.
 */

/** Postgres's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** How far up a `cause` chain to look before giving up. */
const MAX_DEPTH = 5;

/**
 * Whether this failure is a unique index refusing a duplicate.
 *
 * The chain is walked because Drizzle wraps a driver error in a
 * `DrizzleQueryError` and puts the original on `cause`; reading `code` off the
 * top would see nothing and turn a rejected field into a 500.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  for (let current = error, depth = 0; current !== undefined && depth < MAX_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    if ((current as { readonly code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }

  return false;
};

/**
 * A `ZodError` rather than a `ConflictException`, because it *is* a rejected
 * field: the exception filter turns it into a 400 with `fields: [{ path, … }]`,
 * which the form draws under the input the caller has on screen
 * (`http/error-response.ts`). A 409 would be indistinguishable from the api's
 * other conflicts and would have nothing to point at.
 */
export const fieldAlreadyTaken = (path: string, input: unknown = undefined): ZodError =>
  new ZodError([
    {
      code: 'custom',
      path: [path],
      message: 'is already in use on this install',
      input,
    },
  ]);

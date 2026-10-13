/** Postgres' `unique_violation`, however deep the driver or Drizzle wrapped it. */
export const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
};

/** What a log line may say about a failure: its class, and for a database error its SQLSTATE and constraint. */
export interface FailureFields {
  readonly errorClass: string;
  readonly code?: string;
  readonly constraint?: string;
  /** Only for an error that is not the database's: a driver's message quotes the values it was given. */
  readonly message?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

const classOf = (error: unknown): string =>
  error instanceof Error ? error.constructor.name || error.name : typeof error;

/**
 * A failure as a log line may carry it. A failed query's message, stack and
 * `params` hold what was being written, which is a customer's words, a name or
 * a phone number (ARCHITECTURE §14: a log line never carries a body), so for
 * anything with a Postgres SQLSTATE in its chain only the class, the code and
 * the constraint are said. Any other error is a bug of ours and keeps its message.
 */
export const failureFields = (error: unknown): FailureFields => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && SQLSTATE.test(code)) {
      return {
        errorClass: classOf(current),
        code,
        ...(typeof constraint === 'string' ? { constraint } : {}),
      };
    }
    current = (current as { cause?: unknown }).cause;
  }

  return {
    errorClass: classOf(error),
    ...(error instanceof Error ? { message: error.message } : {}),
  };
};

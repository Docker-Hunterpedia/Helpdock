import { AuthError } from '../auth/api.js';

/**
 * A 400 whose body names the fields it refused (`error.fields`), such as a
 * priority name that is too long or already taken. A field path is the one the
 * api's schema reports, e.g. `high.en`.
 *
 * It is an {@link AuthError} of `unavailable`, which is what a 400 with a body
 * was before: every screen that has one sentence for "something went wrong"
 * still gets it, and only the screen that reads `fields` does more.
 */
export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export class FieldValidationError extends AuthError {
  readonly fields: readonly FieldIssue[];

  constructor(fields: readonly FieldIssue[]) {
    super('unavailable', { status: 400 });
    this.name = 'FieldValidationError';
    this.fields = fields;
  }
}

export const isFieldValidationError = (error: unknown): error is FieldValidationError =>
  error instanceof FieldValidationError;

import { TenantContextError } from '@helpdock/db';
import type { AuthErrorBody, ErrorCode, ErrorResponse, FieldError } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { AuthFailure } from '../auth/auth-failure.js';
import { TenantScopeError } from '../tenant/tenant-scope.js';

/**
 * How a thrown thing becomes a response. Split from the filter so it can be
 * tested without an execution context, and so there is one place to read when
 * asking "what does the client learn from this failure?".
 *
 * The rule: a client learns the status, a stable code, a message written for
 * it, and the request id. Everything else — the cause, the stack, the SQL — goes
 * to the log under that same id.
 */

export interface MappedError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly fields?: readonly FieldError[];
  /** Only on a sign-in failure; see `auth/auth-failure.ts`. */
  readonly auth?: AuthErrorBody;
  /** True when the log line should carry the whole error, not just its message. */
  readonly unexpected: boolean;
}

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'validation_failed',
  [HttpStatus.UNAUTHORIZED]: 'unauthenticated',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
};

/** `body.email`, `params.brandId`: the path as the request carried it. */
const fieldErrorsOf = (error: ZodError): readonly FieldError[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));

const zodErrorIn = (exception: ZodValidationException): ZodError | undefined => {
  const error = exception.getZodError();
  return error instanceof ZodError ? error : undefined;
};

export const mapError = (error: unknown): MappedError => {
  // A response that fails its own output schema is a bug in the api, not in the
  // request, and the failing field names a column: 500, and the detail is for
  // the log alone.
  if (error instanceof ZodSerializationException) {
    return internalError();
  }

  if (error instanceof ZodValidationException || error instanceof ZodError) {
    const zodError = error instanceof ZodError ? error : zodErrorIn(error);
    return {
      status: HttpStatus.BAD_REQUEST,
      code: 'validation_failed',
      message: 'The request did not match the expected shape',
      ...(zodError === undefined ? {} : { fields: fieldErrorsOf(zodError) }),
      unexpected: false,
    };
  }

  // Before the generic `HttpException` branch, which would drop the detail the
  // sign-in screens read.
  if (error instanceof AuthFailure) {
    return {
      status: error.getStatus(),
      code: CODE_BY_STATUS[error.getStatus()] ?? 'unauthenticated',
      message: error.message,
      auth: error.auth,
      unexpected: false,
    };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= HttpStatus.INTERNAL_SERVER_ERROR
      ? internalError()
      : {
          status,
          code: CODE_BY_STATUS[status] ?? 'internal_error',
          message: error.message,
          unexpected: false,
        };
  }

  // Both name a context the caller built wrongly, and neither message carries a
  // value: `TenantContextError` names the field, `TenantScopeError` the reason.
  if (error instanceof TenantContextError || error instanceof TenantScopeError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: 'validation_failed',
      message: error.message,
      unexpected: false,
    };
  }

  return internalError();
};

const internalError = (): MappedError => ({
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  code: 'internal_error',
  // Deliberately fixed: an unexpected error's message may quote a row, a query
  // or a connection string.
  message: 'The request could not be completed',
  unexpected: true,
});

export const errorBody = (mapped: MappedError, requestId: string): ErrorResponse => ({
  error: {
    code: mapped.code,
    message: mapped.message,
    requestId,
    ...(mapped.fields === undefined ? {} : { fields: [...mapped.fields] }),
    ...(mapped.auth === undefined ? {} : { auth: mapped.auth }),
  },
});

import type { z } from 'zod';

/**
 * Zod at every boundary (AGENTS.md). For this package the boundaries are the
 * outbox write, the enqueue and the consume, and all three report a bad value
 * the same way: one error naming the subject and every issue, with no value in
 * it, because a payload can carry customer data.
 */

/** One issue from a value that failed its schema, flattened for a log line. */
export interface PayloadIssue {
  /** Dotted path inside the payload, or `(root)` for the payload itself. */
  readonly path: string;
  readonly message: string;
}

export class PayloadValidationError extends Error {
  /** What was being validated: a job name, or `outbox entry`. */
  readonly subject: string;
  readonly issues: readonly PayloadIssue[];

  constructor(subject: string, issues: readonly PayloadIssue[]) {
    super(`Invalid ${subject}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'PayloadValidationError';
    this.subject = subject;
    this.issues = issues;
  }
}

export const flattenIssues = (error: z.ZodError): readonly PayloadIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    message: issue.message,
  }));

/** Parses `data` or throws {@link PayloadValidationError}. */
export const parsePayload = <T>(subject: string, schema: z.ZodType<T>, data: unknown): T => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new PayloadValidationError(subject, flattenIssues(result.error));
  }
  return result.data;
};

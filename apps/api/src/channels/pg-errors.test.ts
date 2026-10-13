import { describe, expect, it } from 'vitest';
import { failureFields, isUniqueViolation } from './pg-errors.js';

class DatabaseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly constraint?: string,
  ) {
    super(message);
  }
}

class DrizzleQueryError extends Error {
  constructor(
    message: string,
    readonly params: unknown[],
    cause: Error,
  ) {
    super(message, { cause });
  }
}

const quoted = (cause: Error): DrizzleQueryError =>
  new DrizzleQueryError(
    'Failed query: insert … params: Hello, I am Dina, +15551234567',
    ['Dina'],
    cause,
  );

describe('isUniqueViolation', () => {
  it('finds the unique violation under the error Drizzle wraps it in', () => {
    expect(isUniqueViolation(quoted(new DatabaseError('duplicate key', '23505', 'k')))).toBe(true);
  });

  it('is false for any other failure', () => {
    expect(isUniqueViolation(quoted(new DatabaseError('deadlock', '40P01')))).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});

describe('failureFields', () => {
  it('says the class, the SQLSTATE and the constraint of a failed query, and none of its words', () => {
    const error = quoted(
      new DatabaseError(
        'duplicate key value violates "x"',
        '23505',
        'ticket_messages_external_key',
      ),
    );

    const fields = failureFields(error);

    expect(fields).toEqual({
      errorClass: 'DatabaseError',
      code: '23505',
      constraint: 'ticket_messages_external_key',
    });
    expect(JSON.stringify(fields)).not.toContain('Dina');
    expect(JSON.stringify(fields)).not.toContain('+1555');
  });

  it('leaves the constraint out when the error names none', () => {
    expect(failureFields(quoted(new DatabaseError('deadlock detected', '40P01')))).toEqual({
      errorClass: 'DatabaseError',
      code: '40P01',
    });
  });

  it('keeps the message of an error that is not the database’s, which is a bug of ours', () => {
    expect(failureFields(new TypeError('x is not a function'))).toEqual({
      errorClass: 'TypeError',
      message: 'x is not a function',
    });
  });

  it('names what is not an error by its type and carries nothing of it', () => {
    expect(failureFields('a customer wrote this')).toEqual({ errorClass: 'string' });
  });
});

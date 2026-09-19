import { describe, expect, it } from 'vitest';
import { classifySmtpError, SmtpTimeoutError } from './smtp-errors.js';

/** What Nodemailer raises: an `Error` with a `code` from its own catalogue. */
const nodemailerError = (code: string): Error => Object.assign(new Error('refused'), { code });

describe('classifySmtpError', () => {
  it.each([
    ['EAUTH', 'auth-failed'],
    ['ENOAUTH', 'auth-failed'],
    ['EOAUTH2', 'auth-failed'],
    ['ETLS', 'tls-error'],
    ['EREQUIRETLS', 'tls-error'],
    ['ETIMEDOUT', 'timeout'],
    ['ECONNECTION', 'connection-refused'],
    ['ESOCKET', 'connection-refused'],
    ['EDNS', 'connection-refused'],
    ['EPROXY', 'connection-refused'],
    ['EENVELOPE', 'rejected'],
    ['EMESSAGE', 'rejected'],
    ['EPROTOCOL', 'rejected'],
  ])('turns Nodemailer %s into %s', (code, expected) => {
    expect(classifySmtpError(nodemailerError(code))).toBe(expected);
  });

  it.each([
    ['ECONNREFUSED', 'connection-refused'],
    ['ENOTFOUND', 'connection-refused'],
    ['EHOSTUNREACH', 'connection-refused'],
    ['ETIMEDOUT', 'timeout'],
  ])("turns the socket layer's own %s into %s", (code, expected) => {
    expect(classifySmtpError(nodemailerError(code))).toBe(expected);
  });

  it('reads `errno` when there is no `code`, which is what a bare socket error carries', () => {
    expect(classifySmtpError(Object.assign(new Error('nope'), { errno: 'ECONNREFUSED' }))).toBe(
      'connection-refused',
    );
  });

  it('reports our own deadline as a timeout, not as something unknown', () => {
    expect(classifySmtpError(new SmtpTimeoutError())).toBe('timeout');
  });

  it.each([
    ['a plain error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['an unrecognised code', nodemailerError('EWHATEVER')],
  ])('falls back to unknown for %s', (_name, error) => {
    expect(classifySmtpError(error)).toBe('unknown');
  });
});

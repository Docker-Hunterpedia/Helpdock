import { describe, expect, it } from 'vitest';
import { classifySmtpError, describeSmtpError, SmtpTimeoutError } from './smtp-errors.js';

describe('describeSmtpError', () => {
  it("prefers the relay's own reply, on one line", () => {
    const error = Object.assign(new Error('Message failed'), {
      response: '550 5.1.1 <mona@example.com>:\r\n  mailbox full',
    });

    expect(describeSmtpError(error, 300)).toBe('550 5.1.1 <mona@example.com>: mailbox full');
  });

  it('falls back to the message of a socket error and bounds the length', () => {
    expect(describeSmtpError(new Error('connect ECONNREFUSED 10.0.0.1:465'), 14)).toBe(
      'connect ECONNR',
    );
    expect(describeSmtpError('plain', 300)).toBe('plain');
  });
});

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

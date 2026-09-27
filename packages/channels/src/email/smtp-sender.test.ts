import type { SmtpCredentials } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { EmailMessage } from './sender.js';
import {
  mailOptions,
  SMTP_TIMEOUT_MS,
  smtpDeadlineMs,
  smtpTransportOptions,
} from './smtp-sender.js';

describe('mailOptions', () => {
  const base: EmailMessage = {
    to: { address: 'mona@example.com', name: 'Mona' },
    subject: 'Re: [HD-1042] Refund',
    text: 'Hi',
    html: '<p>Hi</p>',
    locale: 'en',
  };
  const fallback = { address: 'support@example.com', name: 'Support' };

  it('sends an auth mail as it always did, from the configured sender', () => {
    expect(mailOptions(base, fallback)).toEqual({
      from: fallback,
      to: { address: 'mona@example.com', name: 'Mona' },
      subject: base.subject,
      text: 'Hi',
      html: '<p>Hi</p>',
    });
  });

  it('carries the ticket mail headers through verbatim', () => {
    const options = mailOptions(
      {
        ...base,
        from: { address: 'billing@example.com', name: 'Billing' },
        replyTo: 'billing@example.com',
        cc: [{ address: 'karim@example.com' }],
        messageId: '<hd.m.1@example.com>',
        inReplyTo: '<customer@mail.example>',
        references: ['<customer@mail.example>'],
        headers: { 'Auto-Submitted': 'auto-replied' },
      },
      fallback,
    );

    expect(options).toMatchObject({
      from: { address: 'billing@example.com', name: 'Billing' },
      replyTo: 'billing@example.com',
      cc: [{ address: 'karim@example.com', name: '' }],
      messageId: '<hd.m.1@example.com>',
      inReplyTo: '<customer@mail.example>',
      references: ['<customer@mail.example>'],
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  });

  it('leaves out an empty CC and an empty reference list', () => {
    const options = mailOptions({ ...base, cc: [], references: [] }, fallback);

    expect(options).not.toHaveProperty('cc');
    expect(options).not.toHaveProperty('references');
  });
});

const credentials: SmtpCredentials = {
  host: 'smtp.example.com',
  port: 587,
  tls: 'starttls',
  user: 'postmaster',
  password: 'secret',
  fromAddress: 'support@example.com',
  fromName: 'Acme Support',
};

describe('smtpTransportOptions', () => {
  it('upgrades an open connection and refuses to continue without TLS for starttls', () => {
    expect(smtpTransportOptions(credentials)).toMatchObject({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
    });
  });

  it('connects with TLS from the first byte for tls', () => {
    expect(smtpTransportOptions({ ...credentials, tls: 'tls', port: 465 })).toMatchObject({
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    });
  });

  it('skips STARTTLS entirely for none, which is what a private relay needs', () => {
    expect(smtpTransportOptions({ ...credentials, tls: 'none', port: 25 })).toMatchObject({
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });
  });

  it('sends the credentials only when there is a username', () => {
    expect(smtpTransportOptions(credentials)).toMatchObject({
      auth: { user: 'postmaster', pass: 'secret' },
    });
    expect(smtpTransportOptions({ ...credentials, user: '' })).not.toHaveProperty('auth');
  });

  it('replaces every one of Nodemailer’s minute-long timers with the ten-second deadline', () => {
    expect(smtpTransportOptions(credentials)).toMatchObject({
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      dnsTimeout: SMTP_TIMEOUT_MS,
    });
  });

  it('lets a test shorten the deadline without touching the default', () => {
    expect(smtpTransportOptions(credentials, { timeoutMs: 50 }).socketTimeout).toBe(50);
    expect(SMTP_TIMEOUT_MS).toBe(10_000);
  });
});

describe('smtpDeadlineMs', () => {
  it('uses the default deadline when no override is given', () => {
    expect(smtpDeadlineMs(undefined)).toBe(SMTP_TIMEOUT_MS);
  });

  it('keeps a shorter override as it is', () => {
    expect(smtpDeadlineMs(50)).toBe(50);
  });

  it.each([
    { timeoutMs: 60 * 60_000, expected: SMTP_TIMEOUT_MS },
    { timeoutMs: Number.POSITIVE_INFINITY, expected: SMTP_TIMEOUT_MS },
    { timeoutMs: Number.NaN, expected: SMTP_TIMEOUT_MS },
    { timeoutMs: 0, expected: 1 },
    { timeoutMs: -5, expected: 1 },
  ])('clamps $timeoutMs into [1, SMTP_TIMEOUT_MS]', ({ timeoutMs, expected }) => {
    expect(smtpDeadlineMs(timeoutMs)).toBe(expected);
  });

  it('bounds every Nodemailer timer the same way', () => {
    expect(smtpTransportOptions(credentials, { timeoutMs: 60 * 60_000 })).toMatchObject({
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      dnsTimeout: SMTP_TIMEOUT_MS,
    });
  });
});

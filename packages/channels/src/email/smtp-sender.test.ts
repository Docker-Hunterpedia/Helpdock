import type { SmtpCredentials } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { SMTP_TIMEOUT_MS, smtpTransportOptions } from './smtp-sender.js';

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
    expect(smtpTransportOptions({ ...credentials, timeoutMs: 50 }).socketTimeout).toBe(50);
    expect(SMTP_TIMEOUT_MS).toBe(10_000);
  });
});

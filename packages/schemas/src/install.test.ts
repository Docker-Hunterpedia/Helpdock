import { describe, expect, it } from 'vitest';
import {
  helpcenterDomainSchema,
  installStateSchema,
  isSupportedTimeZone,
  setupAdminRequestSchema,
  setupBrandRequestSchema,
  setupSmtpRequestSchema,
  smtpTestResultSchema,
  ticketNumberPreview,
  ticketPrefixSchema,
  timezoneSchema,
} from './install.js';

describe('installStateSchema', () => {
  it('knows the two states and nothing else', () => {
    expect(installStateSchema.safeParse('fresh').success).toBe(true);
    expect(installStateSchema.safeParse('configured').success).toBe(true);
    expect(installStateSchema.safeParse('half').success).toBe(false);
  });
});

describe('ticketPrefixSchema', () => {
  it.each(['HD', 'ACME', 'A1', 'ACME24'])('accepts %s', (prefix) => {
    expect(ticketPrefixSchema.safeParse(prefix).success).toBe(true);
  });

  it.each([
    ['H', 'one character'],
    ['TOOLONGX', 'more than six'],
    ['hd', 'lower case'],
    ['AC-ME', 'a hyphen'],
    ['AC ME', 'a space'],
    ['', 'empty'],
  ])('refuses %s (%s)', (prefix) => {
    expect(ticketPrefixSchema.safeParse(prefix).success).toBe(false);
  });
});

describe('ticketNumberPreview', () => {
  it('shows what a ticket will look like', () => {
    expect(ticketNumberPreview('ACME')).toBe('ACME-1042');
  });

  it('falls back to the placeholder before anything is typed', () => {
    expect(ticketNumberPreview('')).toBe('HD-1042');
  });
});

describe('timezoneSchema', () => {
  it('accepts a zone this runtime knows', () => {
    expect(timezoneSchema.safeParse('Europe/Berlin').success).toBe(true);
  });

  it('accepts UTC, which the column defaults to and Intl leaves out of its list', () => {
    expect(Intl.supportedValuesOf('timeZone')).not.toContain('UTC');
    expect(isSupportedTimeZone('UTC')).toBe(true);
  });

  it.each(['Mars/Olympus', 'GMT+3', '', 'europe/berlin'])('refuses %j', (zone) => {
    expect(timezoneSchema.safeParse(zone).success).toBe(false);
  });
});

describe('helpcenterDomainSchema', () => {
  it('normalises case and a trailing dot, because neither is ever stored', () => {
    expect(helpcenterDomainSchema.parse(' Support.Example.COM. ')).toBe('support.example.com');
  });

  it.each(['example', 'https://support.example.com', 'support..example.com', '-bad.example.com'])(
    'refuses %j',
    (domain) => {
      expect(helpcenterDomainSchema.safeParse(domain).success).toBe(false);
    },
  );
});

describe('setupAdminRequestSchema', () => {
  const valid = {
    name: ' Lina ',
    email: 'lina@example.com',
    password: 'a very long passphrase',
    locale: 'en',
  };

  it('trims the name, because it is shown beside every reply', () => {
    expect(setupAdminRequestSchema.parse(valid).name).toBe('Lina');
  });

  it('refuses a locale Helpdock does not ship', () => {
    expect(setupAdminRequestSchema.safeParse({ ...valid, locale: 'fr' }).success).toBe(false);
  });

  it('enforces the twelve-character floor and nothing more about the password', () => {
    // Composition rules push people towards `Passw0rd!`; the bar on the step
    // is a hint, not a second policy (M0-06, `ui/password-strength.ts`).
    expect(setupAdminRequestSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    expect(setupAdminRequestSchema.safeParse({ ...valid, password: 'twelveletter' }).success).toBe(
      true,
    );
  });
});

describe('setupBrandRequestSchema', () => {
  const valid = {
    name: 'Acme',
    prefix: 'ACME',
    defaultLocale: 'ar',
    timezone: 'Asia/Riyadh',
  };

  it('accepts a brand with no help center domain', () => {
    expect(setupBrandRequestSchema.parse(valid).helpcenterDomain).toBeUndefined();
  });

  it('accepts and normalises one with a domain', () => {
    expect(
      setupBrandRequestSchema.parse({ ...valid, helpcenterDomain: 'Support.Acme.TEST' })
        .helpcenterDomain,
    ).toBe('support.acme.test');
  });

  it('refuses a prefix the ticket numbers could not carry', () => {
    expect(setupBrandRequestSchema.safeParse({ ...valid, prefix: 'acme!' }).success).toBe(false);
  });
});

describe('setupSmtpRequestSchema', () => {
  const credentials = {
    host: 'smtp.example.com',
    port: 587,
    tls: 'starttls',
    user: 'postmaster',
    password: 'secret',
    fromAddress: 'support@example.com',
    fromName: 'Acme Support',
  };

  it('accepts a full set of credentials', () => {
    expect(setupSmtpRequestSchema.safeParse({ ...credentials, skip: false }).success).toBe(true);
  });

  it('accepts a skip with nothing else, so nothing half-filled is ever stored', () => {
    expect(setupSmtpRequestSchema.safeParse({ skip: true }).success).toBe(true);
  });

  it('refuses credentials that forget to say which branch they are', () => {
    expect(setupSmtpRequestSchema.safeParse(credentials).success).toBe(false);
  });

  it('refuses a port outside the range a socket can use', () => {
    expect(
      setupSmtpRequestSchema.safeParse({ ...credentials, port: 70_000, skip: false }).success,
    ).toBe(false);
  });

  it('refuses a TLS mode the transport has no meaning for', () => {
    expect(
      setupSmtpRequestSchema.safeParse({ ...credentials, tls: 'ssl', skip: false }).success,
    ).toBe(false);
  });
});

describe('smtpTestResultSchema', () => {
  it('carries either a reply or an error code, never a server sentence', () => {
    expect(smtpTestResultSchema.parse({ delivered: true, response: '250 OK' })).toEqual({
      delivered: true,
      response: '250 OK',
    });
    expect(smtpTestResultSchema.parse({ delivered: false, error: 'auth-failed' }).error).toBe(
      'auth-failed',
    );
    expect(smtpTestResultSchema.safeParse({ delivered: false, error: 'nope' }).success).toBe(false);
  });

  it('refuses a reply longer than the card would draw', () => {
    expect(
      smtpTestResultSchema.safeParse({ delivered: true, response: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

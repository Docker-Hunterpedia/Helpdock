import type { InboundParseSettings as InboundParseSettingsRow } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { toEmailView } from './email-view.js';
import { ImapConnectionTester, imapConnectOptions } from './imap-connector.js';
import { presentedSecret } from './inbound/inbound-parse.service.js';
import { toInboundParseSettings, toMailbox } from './mailbox-view.js';
import type { MailboxWithNames } from './mailboxes.repository.js';

/**
 * The pure pieces of M2's inbound half. The routes, the pipeline and the
 * poller run against real Postgres, Redis and GreenMail in
 * `channels.integration.test.ts`.
 */

describe('presentedSecret', () => {
  it('prefers the header, and falls back to the password of Basic auth', () => {
    expect(presentedSecret({ secretHeader: ' s1 ', authorization: undefined })).toBe('s1');
    expect(
      presentedSecret({
        secretHeader: undefined,
        authorization: `Basic ${Buffer.from('inbound:s2:with-colon').toString('base64')}`,
      }),
    ).toBe('s2:with-colon');
  });

  it('finds nothing in an empty header, a bearer token or a Basic auth with no password', () => {
    expect(presentedSecret({ secretHeader: '', authorization: 'Bearer x' })).toBeUndefined();
    expect(
      presentedSecret({
        secretHeader: undefined,
        authorization: `Basic ${Buffer.from('only-a-user').toString('base64')}`,
      }),
    ).toBeUndefined();
    expect(
      presentedSecret({
        secretHeader: undefined,
        authorization: `Basic ${Buffer.from('user:').toString('base64')}`,
      }),
    ).toBeUndefined();
  });
});

describe('toEmailView', () => {
  const meta = {
    from: { address: 'mona@example.com', name: 'Mona' },
    to: [],
    cc: [],
    date: null,
    quotedHtml: null,
    remoteImages: [
      { url: 'https://a.example/1.png', alt: '' },
      { url: 'https://a.example/2.png', alt: '' },
      { url: 'https://b.example/3.png', alt: '' },
    ],
    remoteImagePolicy: 'proxy',
    inlineAttachmentIds: [],
    authFailed: false,
    mismatch: null,
  };

  it('keeps the count and the hosts and never the URLs', () => {
    const view = toEmailView(meta);

    expect(view?.remoteImages).toEqual({
      count: 3,
      hosts: ['a.example', 'b.example'],
      policy: 'proxy',
    });
    expect(JSON.stringify(view)).not.toContain('1.png');
  });

  it('draws a row it cannot read as no card at all', () => {
    expect(toEmailView({ nonsense: true })).toBeUndefined();
  });
});

describe('the mailbox views', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const row = (overrides: Partial<MailboxWithNames['mailbox']> = {}): MailboxWithNames => ({
    departmentName: 'Support',
    passwordUpdatedByName: 'Lina',
    mailbox: {
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e1',
      brandId: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
      address: 'support@helpdock.io',
      displayName: 'Support',
      departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
      method: 'imap',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecurity: 'tls',
      imapUsername: 'u',
      imapPassword: 'v1.x',
      imapPasswordUpdatedAt: now,
      imapPasswordUpdatedBy: null,
      imapFolder: 'INBOX',
      pollIntervalSeconds: 60,
      imapUidValidity: null,
      imapLastUid: null,
      remoteImages: 'block',
      authFailureIsSpam: false,
      automatedAllowlist: [],
      inboundProvider: null,
      lastPolledAt: null,
      lastSuccessAt: now,
      lastReceivedAt: null,
      lastError: 'weird',
      lastErrorKind: 'not-a-kind',
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
  });

  it('says a password is set without saying what it is', () => {
    const view = toMailbox(row(), now);

    expect(view.imap).toMatchObject({ passwordSet: true, passwordUpdatedByName: 'Lina' });
    expect(JSON.stringify(view)).not.toContain('v1.x');
    expect(view.health.lastErrorKind).toBeNull();
  });

  it('has no IMAP half for an inbound-parse mailbox, or an IMAP row missing a field', () => {
    expect(toMailbox(row({ method: 'inbound_parse' }), now).imap).toBeNull();
    expect(toMailbox(row({ imapHost: null }), now).imap).toBeNull();
  });

  it('reads the inbound-parse card, with or without a last request', () => {
    expect(toInboundParseSettings(undefined)).toEqual({
      secretSet: false,
      secretUpdatedAt: null,
      lastRequest: null,
    });
    const settings: InboundParseSettingsRow = {
      brandId: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
      secret: 'v1.y',
      secretUpdatedAt: now,
      secretUpdatedBy: null,
      lastRequestProvider: 'postmark',
      lastRequestAt: now,
      lastRequestOutcome: 'accepted',
    };
    expect(toInboundParseSettings(settings)).toEqual({
      secretSet: true,
      secretUpdatedAt: now.toISOString(),
      lastRequest: { provider: 'postmark', at: now.toISOString(), outcome: 'accepted' },
    });
    expect(
      toInboundParseSettings({ ...settings, lastRequestProvider: 'fax' }).lastRequest,
    ).toBeNull();
  });
});

describe('ImapConnectionTester', () => {
  const settings = {
    host: '127.0.0.1',
    port: 1,
    security: 'tls' as const,
    username: 'u',
    password: 'p',
    folder: 'INBOX',
  };

  it('refuses an internal host before connecting, and says why', async () => {
    const result = await new ImapConnectionTester(imapConnectOptions({ allowCidrs: [] })).test(
      settings,
    );

    expect(result).toMatchObject({ ok: false, kind: 'connect', host: '127.0.0.1', port: 1 });
    expect(result.ok ? '' : result.serverResponse).toMatch(/blocked/);
  });

  it('reports a closed port as a connection failure when the operator allows the range', async () => {
    const result = await new ImapConnectionTester({
      ...imapConnectOptions({ allowCidrs: ['127.0.0.0/8'], tls: { rejectUnauthorized: false } }),
      timeoutMs: 2_000,
    }).test(settings);

    expect(result).toMatchObject({ ok: false });
  });
});

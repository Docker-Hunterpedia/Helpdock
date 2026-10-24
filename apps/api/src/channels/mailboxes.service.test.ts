import { createKeyring, decryptSecret, encryptSecret } from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import type { MailboxUpdateRequest } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { ChannelsFailure } from './channels-failure.js';
import type { MailboxesRepository, MailboxWithNames } from './mailboxes.repository.js';
import { type ImapTester, MailboxesService } from './mailboxes.service.js';

vi.mock('@helpdock/jobs', () => ({ enqueueOutbox: vi.fn(async () => undefined) }));

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') });
const now = new Date('2026-10-24T12:00:00Z');
const MAILBOX_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000000e1';
const DEPARTMENT_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

const storedRow = (): MailboxWithNames => ({
  departmentName: 'Support',
  passwordUpdatedByName: null,
  mailbox: {
    id: MAILBOX_ID,
    brandId: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
    address: 'support@helpdock.io',
    displayName: 'Support',
    departmentId: DEPARTMENT_ID,
    method: 'imap',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecurity: 'tls',
    imapUsername: 'desk',
    imapPassword: encryptSecret('stored-password', keyring),
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
    lastSuccessAt: null,
    lastReceivedAt: null,
    lastError: null,
    lastErrorKind: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
  },
});

const harness = () => {
  const row = storedRow();
  const updates: Record<string, unknown>[] = [];
  const repository = {
    find: async () => row,
    departmentExists: async () => true,
    update: async (_tx: unknown, _id: string, values: Record<string, unknown>) => {
      updates.push(values);
      return row.mailbox;
    },
  } as unknown as MailboxesRepository;
  const tested: Parameters<ImapTester['test']>[0][] = [];
  const imap: ImapTester = {
    test: async (settings) => {
      tested.push(settings);
      return {
        ok: true,
        host: settings.host,
        port: settings.port,
        folder: 'INBOX',
        messages: 0,
        unseen: 0,
      };
    },
  };
  const service = new MailboxesService({ repository, keyring, imap, now: () => now });
  const tx = { insert: () => ({ values: async () => undefined }) } as unknown as DbTransaction;
  const context = {
    tx,
    brandId: row.mailbox.brandId,
    actor: { userId: 'u1' },
  } as unknown as TicketingContext;

  return { service, context, tx, updates, tested };
};

const updateRequest = (imap: Partial<Extract<MailboxUpdateRequest, { method: 'imap' }>['imap']>) =>
  ({
    address: 'support@helpdock.io',
    displayName: 'Support',
    departmentId: DEPARTMENT_ID,
    method: 'imap',
    remoteImages: 'block',
    authFailureIsSpam: false,
    automatedAllowlist: [],
    imap: {
      host: 'imap.example.com',
      port: 993,
      security: 'tls',
      username: 'desk',
      folder: 'INBOX',
      pollIntervalSeconds: 60,
      ...imap,
    },
  }) as MailboxUpdateRequest;

const refusal = async (promise: Promise<unknown>): Promise<ChannelsFailure> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ChannelsFailure);

  return error as ChannelsFailure;
};

describe('MailboxesService.update: the stored IMAP password follows its server', () => {
  it('keeps the stored password while host, port, user and TLS mode are unchanged', async () => {
    const { service, context, updates } = harness();

    await service.update(
      context,
      MAILBOX_ID,
      updateRequest({ host: 'IMAP.example.com', pollIntervalSeconds: 300 }),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('imapPassword');
  });

  it.each([
    ['host', { host: 'evil.example.net' }],
    ['port', { port: 143 }],
    ['TLS mode', { security: 'starttls' as const }],
    ['username', { username: 'someone-else' }],
  ])('asks for the password again when the %s changes, and saves nothing', async (_, change) => {
    const { service, context, updates } = harness();

    const failure = await refusal(service.update(context, MAILBOX_ID, updateRequest(change)));

    expect(failure.reason).toBe('password-required');
    expect(failure.getStatus()).toBe(400);
    expect(failure.field).toBe('body.imap.password');
    expect(updates).toHaveLength(0);
  });

  it('accepts a changed server with a newly typed password', async () => {
    const { service, context, updates } = harness();

    await service.update(
      context,
      MAILBOX_ID,
      updateRequest({ host: 'imap.other.example', password: 'new-password' }),
    );

    expect(decryptSecret(updates[0]?.imapPassword as string, keyring)).toBe('new-password');
  });
});

describe('MailboxesService.testImap: the stored password follows its server', () => {
  const settings = {
    host: 'imap.example.com',
    port: 993,
    security: 'tls' as const,
    username: 'desk',
    folder: 'INBOX',
    mailboxId: MAILBOX_ID,
  };

  it('tests with the stored password while the server is unchanged', async () => {
    const { service, tx, tested } = harness();

    await service.testImap(tx, settings);

    expect(tested.map((call) => call.password)).toEqual(['stored-password']);
  });

  it.each([
    ['host', { host: 'evil.example.net' }],
    ['port', { port: 143 }],
    ['TLS mode', { security: 'starttls' as const }],
    ['username', { username: 'someone-else' }],
  ])('refuses and connects nowhere when the %s changed', async (_, change) => {
    const { service, tx, tested } = harness();

    const failure = await refusal(service.testImap(tx, { ...settings, ...change }));

    expect(failure.reason).toBe('password-required');
    expect(failure.field).toBe('body.password');
    expect(tested).toHaveLength(0);
  });

  it('tests a changed server with a typed password', async () => {
    const { service, tx, tested } = harness();

    await service.testImap(tx, { ...settings, host: 'imap.other.example', password: 'typed' });

    expect(tested.map((call) => [call.host, call.password])).toEqual([
      ['imap.other.example', 'typed'],
    ]);
  });
});

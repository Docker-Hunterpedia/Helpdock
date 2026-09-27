import { createKeyring, decryptSecret } from '@helpdock/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  FakeEmailRepository,
  installSmtp,
  recordingTransports,
  recordingTx,
} from '../testing/email-doubles.js';
import {
  BILLING,
  BRAND,
  deliveryRow,
  MESSAGE,
  REFUNDS,
  ROW_A,
  ROW_B,
  ROW_C,
  settingsRow,
  TICKET,
  USER,
} from '../testing/email-fixtures.js';
import { EmailSettingsService } from './email-settings.service.js';
import { OutboundEmailService } from './outbound-email.service.js';
import { autoRepliesFrom } from './outgoing-settings.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') });
const NOW = new Date('2026-09-27T09:00:00Z');

const setup = (install: Parameters<typeof installSmtp>[0] = undefined) => {
  const repository = new FakeEmailRepository();
  repository.users.set(USER, { name: 'Lina Haddad', email: 'lina@helpdock.io', locale: 'en' });
  const transports = recordingTransports();
  const smtp = installSmtp(install);
  const service = new EmailSettingsService({
    repository: repository.asRepository,
    outbound: new OutboundEmailService(repository.asRepository, smtp),
    keyring,
    installSmtp: smtp,
    transports: transports.factory,
    now: () => NOW,
  });
  const recording = recordingTx();
  const context = { tx: recording.tx, brandId: BRAND, actorId: USER };
  return { repository, transports, service, context, ...recording };
};

const smtpBody = {
  host: 'smtp.fastmail.com',
  port: 465,
  tls: 'tls' as const,
  user: 'support@helpdock.io',
};

describe('EmailSettingsService.outgoing', () => {
  it('shows a brand that never saved the defaults, and whether the install can send', async () => {
    const { service, tx } = setup({
      server: { host: 'relay', port: 25, tls: 'none', user: '', password: '' },
      from: undefined,
    });

    const view = await service.outgoing(tx, BRAND);

    expect(view.smtp).toBeNull();
    expect(view.installSmtpConfigured).toBe(true);
    expect(view.senders).toEqual({ defaultFrom: null, departments: [] });
    expect(view.autoReplies.perSenderHourlyCap).toBe(3);
  });

  it('names who saved the server last', async () => {
    const { service, tx, repository } = setup();
    repository.settingsRow = settingsRow({ smtpHost: 'h', smtpPort: 25, smtpUpdatedBy: USER });

    expect((await service.outgoing(tx, BRAND)).smtp?.updatedByName).toBe('Lina Haddad');
  });
});

describe('EmailSettingsService.saveSmtp', () => {
  it('encrypts a new password and audits that it changed, never what it is', async () => {
    const { service, context, repository, audit } = setup();

    await service.saveSmtp(context, { ...smtpBody, password: 'app-password' });

    const saved = repository.saved[0] as { smtpPassword: string; smtpUpdatedBy: string };
    expect(saved.smtpPassword).not.toBe('app-password');
    expect(decryptSecret(saved.smtpPassword, keyring)).toBe('app-password');
    expect(saved.smtpUpdatedBy).toBe(USER);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('app-password');
    expect(audit[0]).toMatchObject({
      action: 'email.smtp.updated',
      meta: { passwordChanged: true },
    });
  });

  it('keeps the stored password when none is sent, and clears it when an empty one is', async () => {
    const { service, context, repository } = setup();

    await service.saveSmtp(context, smtpBody);
    await service.saveSmtp(context, { ...smtpBody, password: '' });

    expect(repository.saved[0]).not.toHaveProperty('smtpPassword');
    expect(repository.saved[1]).toMatchObject({ smtpPassword: null });
  });
});

describe('EmailSettingsService.testSmtp', () => {
  it('sends one message to the person testing, through the server on screen', async () => {
    const { service, context, transports } = setup();

    const result = await service.testSmtp(context, { ...smtpBody, password: 'typed' });

    expect(result).toMatchObject({ delivered: true, recipient: 'lina@helpdock.io' });
    expect(transports.servers[0]).toMatchObject({ host: 'smtp.fastmail.com', password: 'typed' });
    expect(transports.sent[0]?.to.address).toBe('lina@helpdock.io');
    expect(transports.closed).toBe(1);
  });

  it("reports the relay's refusal as a code and its own words", async () => {
    const { service, context, transports } = setup();
    transports.failWith = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
      response: '535 5.7.8 Authentication credentials invalid',
    });

    const result = await service.testSmtp(context, smtpBody);

    expect(result).toMatchObject({
      delivered: false,
      error: 'auth-failed',
      detail: '535 5.7.8 Authentication credentials invalid',
    });
    expect(transports.closed).toBe(1);
  });

  it('is a 404 for an actor with no account row', async () => {
    const { service, context, repository } = setup();
    repository.users.clear();

    await expect(service.testSmtp(context, smtpBody)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EmailSettingsService.saveSenders', () => {
  const sender = {
    departmentId: BILLING,
    from: { name: 'Billing', address: 'billing@helpdock.io' },
    replyTo: null,
  };

  it('stores the default and each department', async () => {
    const { service, context, repository } = setup();

    await service.saveSenders(context, {
      defaultFrom: { name: 'Support', address: 'support@helpdock.io' },
      departments: [sender],
    });

    expect(repository.saved[0]).toEqual({
      defaultFromName: 'Support',
      defaultFromAddress: 'support@helpdock.io',
      departmentSenders: [
        {
          departmentId: BILLING,
          fromName: 'Billing',
          fromAddress: 'billing@helpdock.io',
          replyTo: null,
        },
      ],
    });
  });

  it('refuses a department this brand does not have', async () => {
    const { service, context } = setup();

    await expect(
      service.saveSenders(context, {
        defaultFrom: null,
        departments: [{ ...sender, departmentId: REFUNDS }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('EmailSettingsService.saveAutoReplies', () => {
  it('stores the toggles, the cap and only the wording that changed', async () => {
    const { service, context, repository } = setup();
    const replies = autoRepliesFrom(undefined);

    await service.saveAutoReplies(context, {
      ...replies,
      acknowledgment: { ...replies.acknowledgment, enabled: true },
      perSenderHourlyCap: 5,
    });

    expect(repository.saved[0]).toEqual({
      acknowledgmentEnabled: true,
      outOfHoursEnabled: false,
      autoReplyHourlyCap: 5,
      autoReplyTemplates: {},
    });
  });
});

describe('Failed sends', () => {
  it('lists dead-lettered sends with the attempts out of five', async () => {
    const { service, tx, repository } = setup();
    repository.deliveries = [
      deliveryRow({
        id: ROW_A,
        status: 'failed',
        attempts: 5,
        lastError: '550 mailbox full',
        failedAt: NOW,
      }),
      deliveryRow({ id: ROW_B, status: 'sent' }),
    ];

    expect(await service.failedSends(tx)).toEqual({
      items: [
        {
          id: ROW_A,
          recipient: 'mona@example.com',
          ticketId: TICKET,
          ticketReference: 'HD-1042',
          lastError: '550 mailbox full',
          attempts: 5,
          maxAttempts: 5,
          failedAt: NOW.toISOString(),
        },
      ],
    });
  });

  it('retries one, retries all, and discards, each audited', async () => {
    const { service, context, repository, audit, outbox } = setup();
    repository.deliveries = [
      deliveryRow({ id: ROW_A, status: 'failed' }),
      deliveryRow({ id: ROW_B, status: 'failed', ticketMessageId: 'other' }),
      deliveryRow({ id: ROW_C, status: 'failed', ticketMessageId: 'third' }),
    ];

    await service.retry(context, ROW_A);
    await service.discard(context, ROW_B);
    expect(await service.retryAll(context)).toBe(1);

    expect(outbox.map((row) => row.payload.deliveryId)).toEqual([ROW_A, ROW_C]);
    expect(audit.map((row) => row.action)).toEqual([
      'email.send.retried',
      'email.send.discarded',
      'email.send.retried',
    ]);
    expect(await service.retryAll(context)).toBe(0);
  });

  it('is a 404 for a send that is not failed', async () => {
    const { service, context, repository } = setup();
    repository.deliveries = [deliveryRow({ id: ROW_A, status: 'sent' })];

    await expect(service.retry(context, ROW_A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.discard(context, ROW_A)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('signatures', () => {
  it('stores an empty signature as none and reads none as empty', async () => {
    const { service, tx, repository } = setup();

    expect(await service.signature(tx, USER)).toEqual({ en: '', ar: '' });
    expect(await service.saveSignature(tx, USER, { en: 'Lina', ar: '  ' })).toEqual({
      en: 'Lina',
      ar: '',
    });
    expect(repository.signatures.get(USER)).toEqual({ en: 'Lina', ar: null });
  });
});

describe('the ticket view', () => {
  it("offers the brand's senders, preselects the department's, and marks each reply", async () => {
    const { service, tx, repository } = setup();
    repository.settingsRow = settingsRow();
    repository.signatures.set(USER, { en: 'Lina Haddad\nBilling', ar: null });
    repository.deliveries = [
      deliveryRow({ status: 'failed', attempts: 5, lastError: '550' }),
      deliveryRow({ id: ROW_C, kind: 'acknowledgment', ticketMessageId: null }),
    ];

    const context = await service.ticketContext(tx, BRAND, TICKET, USER);

    expect(context.senders.map((option) => option.key)).toEqual(['default', BILLING]);
    expect(context.selectedKey).toBe(BILLING);
    expect(context.to).toEqual({ name: 'Mona Khalil', address: 'mona@example.com' });
    expect(context.signature).toBe('Lina Haddad\nBilling');
    expect(context.deliveries).toEqual([
      { messageId: MESSAGE, status: 'failed', attempts: 5, lastError: '550' },
    ]);
  });

  it('is a 404 for a ticket the reader cannot see', async () => {
    const { service, tx, repository } = setup();
    repository.addressingRow = undefined;

    await expect(service.ticketContext(tx, BRAND, TICKET, USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("retries a reply's send from the thread, and 404s one that has none", async () => {
    const { service, context, repository, outbox } = setup();
    repository.deliveries = [deliveryRow({ status: 'discarded' })];

    await service.retryMessage(context, TICKET, MESSAGE);
    expect(outbox).toHaveLength(1);

    await expect(service.retryMessage(context, TICKET, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

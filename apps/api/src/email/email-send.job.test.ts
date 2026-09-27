import { createKeyring, encryptSecret } from '@helpdock/config';
import { silentLogger } from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  FakeEmailRepository,
  installSmtp,
  recordingTransports,
  recordingTx,
} from '../testing/email-doubles.js';
import { BRAND, DELIVERY, deliveryRow, settingsRow, TICKET } from '../testing/email-fixtures.js';
import type { SendFacts } from './email.repository.js';
import { createEmailSendHandler, isLastAttempt, NoSmtpServerError } from './email-send.job.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });

const facts: SendFacts = {
  ticket: { id: TICKET, reference: 'HD-1042', subject: 'Refund', contactId: null },
  brandName: 'Helpdock',
  departmentName: 'Billing',
  contactName: 'Mona Khalil',
  message: { bodyHtml: '<p>Done.</p>', bodyText: 'Done.', authorId: null, authorType: 'staff' },
  author: null,
  transcript: [],
};

const install = {
  server: { host: 'mailpit', port: 1025, tls: 'none' as const, user: '', password: '' },
  from: { address: 'noreply@install.example', name: 'Install' },
};

const setup = (options: { install?: typeof install | undefined } = { install }) => {
  const repository = new FakeEmailRepository();
  repository.deliveries = [deliveryRow()];
  repository.facts = facts;
  const transports = recordingTransports();
  const handler = createEmailSendHandler({
    repository: repository.asRepository,
    keyring,
    installSmtp: installSmtp(options.install),
    transports: transports.factory,
    now: () => new Date('2026-09-27T10:00:00Z'),
  });
  const run = () =>
    handler({
      payload: { brandId: BRAND, deliveryId: DELIVERY },
      brandId: BRAND,
      tx: recordingTx().tx,
      job: {} as Job,
      log: silentLogger,
    });
  return { repository, transports, run };
};

describe('the email.send handler', () => {
  it("sends through the install's server and marks the row sent", async () => {
    const { repository, transports, run } = setup();

    await run();

    expect(transports.sent).toHaveLength(1);
    expect(transports.sent[0]?.messageId).toBe(deliveryRow().messageId);
    expect(transports.servers[0]?.host).toBe('mailpit');
    expect(transports.closed).toBe(1);
    expect(repository.deliveries[0]?.status).toBe('sent');
  });

  it("prefers the brand's own server, with its password decrypted", async () => {
    const { repository, transports, run } = setup();
    repository.settingsRow = settingsRow({
      smtpHost: 'smtp.fastmail.com',
      smtpPort: 465,
      smtpTls: 'tls',
      smtpUser: 'support@helpdock.io',
      smtpPassword: encryptSecret('app-password', keyring),
    });

    await run();

    expect(transports.servers[0]).toEqual({
      host: 'smtp.fastmail.com',
      port: 465,
      tls: 'tls',
      user: 'support@helpdock.io',
      password: 'app-password',
    });
  });

  it('sends nothing for a row that is already sent, discarded or failed', async () => {
    for (const status of ['sent', 'discarded', 'failed'] as const) {
      const { repository, transports, run } = setup();
      repository.deliveries = [deliveryRow({ status })];

      await run();

      expect(transports.sent).toEqual([]);
    }
  });

  it('sends nothing when the ticket is gone', async () => {
    const { repository, transports, run } = setup();
    repository.facts = undefined;

    await run();

    expect(transports.sent).toEqual([]);
  });

  it('fails, to be retried, when there is no server anywhere', async () => {
    const { run } = setup({ install: undefined });

    await expect(run()).rejects.toBeInstanceOf(NoSmtpServerError);
  });

  it('closes the transport and leaves the row queued when the relay refuses', async () => {
    const { repository, transports, run } = setup();
    transports.failWith = Object.assign(new Error('refused'), { responseCode: 550 });

    await expect(run()).rejects.toThrow('refused');
    expect(transports.closed).toBe(1);
    expect(repository.deliveries[0]?.status).toBe('queued');
  });
});

describe('isLastAttempt', () => {
  const job = (attemptsMade: number, attempts = 5) => ({ attemptsMade, opts: { attempts } }) as Job;

  it('counts the attempts before this one', () => {
    expect(isLastAttempt(job(3), new Error('x'))).toBe(false);
    expect(isLastAttempt(job(4), new Error('x'))).toBe(true);
  });

  it('treats an unrecoverable error as the last attempt, whatever the count', () => {
    expect(isLastAttempt(job(0), new UnrecoverableError('bad payload'))).toBe(true);
  });

  it("falls back to the job definition's attempts", () => {
    expect(isLastAttempt({ attemptsMade: 4, opts: {} } as Job, new Error('x'))).toBe(true);
  });
});

import type { EmailMessage, EmailSender } from '@helpdock/channels';
import { createKeyring, encryptSecret } from '@helpdock/config';
import type { Db, DbTransaction, User } from '@helpdock/db';
import { type AuthEmailPayload, authEmailJob, type JobLogger } from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  composeAuthEmail,
  createAuthEmailEventHandler,
  createAuthEmailHandler,
  createAuthEmailProcessor,
} from './auth-email.job.js';
import { AUTH_EMAIL_EVENT } from './auth-email.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const OUTBOX = '0199f4b2-5555-7000-8000-000000000001';
const USER = '0199f4b2-1111-7000-8000-000000000002';
const TOKEN = 'a-working-sign-in-token';
const URL_WITH_TOKEN = `https://support.example.com/api/auth/magic-link/${TOKEN}`;

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });

const user = (overrides: Partial<User> = {}): User =>
  ({
    id: USER,
    email: 'omar@helpdock.test',
    name: 'Omar Nasser',
    locale: 'en',
    status: 'active',
    deactivatedAt: null,
    ...overrides,
  }) as User;

const payload = (overrides: Partial<AuthEmailPayload> = {}): AuthEmailPayload => ({
  brandId: BRAND,
  sourceOutboxId: OUTBOX,
  kind: 'magicLink',
  userId: USER,
  urlEncrypted: encryptSecret(URL_WITH_TOKEN, keyring),
  expiresIn: 10,
  ...overrides,
});

/** A transaction whose one read is the recipient's row. */
const txWith = (row: User | undefined): DbTransaction =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(row === undefined ? [] : [row]) }),
      }),
    }),
  }) as unknown as DbTransaction;

const recordingLog = () => {
  const lines: string[] = [];
  const record = (fields: Record<string, unknown>, message: string) => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const log: JobLogger = { info: record, warn: record, error: record };

  return { log, lines };
};

const harness = ({ smtp = true }: { smtp?: boolean } = {}) => {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  const handler = createAuthEmailHandler({
    senders: { systemSender: () => Promise.resolve(smtp ? sender : null) },
    keyring,
  });
  const { log, lines } = recordingLog();
  const run = (job: AuthEmailPayload, recipient: User | null = user()) =>
    handler({
      payload: job,
      brandId: BRAND,
      tx: txWith(recipient ?? undefined),
      job: {} as Job,
      log,
    });

  return { sent, lines, run };
};

describe('the auth.email_requested handler', () => {
  it('adds one job per outbox row, keyed by the row, carrying the link still sealed', async () => {
    const added: { jobId: string; payload: AuthEmailPayload }[] = [];
    const sealed = encryptSecret(URL_WITH_TOKEN, keyring);

    await createAuthEmailEventHandler({
      add: (jobId, job) => {
        added.push({ jobId, payload: job });
        return Promise.resolve();
      },
    })({
      outboxId: OUTBOX,
      brandId: BRAND,
      event: AUTH_EMAIL_EVENT,
      payload: { kind: 'passwordReset', userId: USER, urlEncrypted: sealed, expiresIn: 10 },
      tx: {} as DbTransaction,
      log: recordingLog().log,
    });

    expect(added).toEqual([
      {
        jobId: `auth.email.${OUTBOX}`,
        payload: {
          brandId: BRAND,
          sourceOutboxId: OUTBOX,
          kind: 'passwordReset',
          userId: USER,
          urlEncrypted: sealed,
          expiresIn: 10,
        },
      },
    ]);
  });
});

describe('composeAuthEmail', () => {
  it('opens the link and renders it in the recipient own language', () => {
    const message = composeAuthEmail(payload(), user({ locale: 'ar' }), keyring);

    expect(message.locale).toBe('ar');
    expect(message.to).toEqual({ address: 'omar@helpdock.test', name: 'Omar Nasser' });
    expect(message.text).toContain(URL_WITH_TOKEN);
    expect(message.html).toContain('dir="rtl"');
  });

  it('names the inviter, the brand and the role in an invitation', () => {
    const message = composeAuthEmail(
      payload({
        kind: 'invite',
        expiresIn: 7,
        values: { inviter: 'Lina Haddad', brandName: 'Acme', role: 'Agent' },
      }),
      user({ status: 'invited' }),
      keyring,
    );

    expect(message.text).toContain('Lina Haddad');
    expect(message.text).toContain('Acme');
  });
});

describe('the auth.email job', () => {
  it('sends the message from the system sender and logs no part of the link', async () => {
    const { sent, lines, run } = harness();

    await run(payload());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(URL_WITH_TOKEN);
    expect(lines.join('\n')).toContain('auth email sent');
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('logs that the email would have been sent when the install has no SMTP, without the link', async () => {
    const { sent, lines, run } = harness({ smtp: false });

    await run(payload({ kind: 'passwordReset' }));

    expect(sent).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Auth email not sent: this install has no SMTP settings');
    expect(lines[0]).toContain(USER);
    expect(lines[0]).not.toContain(TOKEN);
  });

  it.each([
    ['gone', null],
    ['deactivated', user({ status: 'deactivated' })],
    ['marked deactivated', user({ deactivatedAt: new Date() })],
  ])('sends nothing to an account that is %s by the time the job runs', async (_label, row) => {
    const { sent, lines, run } = harness();

    await run(payload(), row);

    expect(sent).toEqual([]);
    expect(lines.join('\n')).toContain('gone or deactivated');
  });

  it('fails for good, without the link in the reason, when the envelope cannot be opened', async () => {
    const { run } = harness();
    const other = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') });
    const sealedElsewhere = encryptSecret(URL_WITH_TOKEN, other);

    const failure = run(payload({ urlEncrypted: sealedElsewhere }));

    await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(failure).rejects.not.toThrow(TOKEN);
  });

  it('lets a send that failed throw, so BullMQ retries it', async () => {
    const handler = createAuthEmailHandler({
      senders: {
        systemSender: () =>
          Promise.resolve({ send: () => Promise.reject(new Error('connection refused')) }),
      },
      keyring,
    });

    await expect(
      handler({
        payload: payload(),
        brandId: BRAND,
        tx: txWith(user()),
        job: {} as Job,
        log: recordingLog().log,
      }),
    ).rejects.toThrow('connection refused');
  });

  it('is the processor for the auth.email job name only', async () => {
    const processor = createAuthEmailProcessor(
      { senders: { systemSender: () => Promise.resolve(null) }, keyring },
      { db: {} as Db },
    );

    await expect(processor({ name: 'notify.email', id: '1', data: {} } as Job)).rejects.toThrow(
      /only handles auth\.email/,
    );
    await expect(processor({ name: authEmailJob.name, id: '1', data: {} } as Job)).rejects.toThrow(
      /auth\.email/,
    );
  });
});

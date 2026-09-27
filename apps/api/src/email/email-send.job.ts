import { describeSmtpError } from '@helpdock/channels';
import type { Keyring } from '@helpdock/config';
import { type Db, withSystem } from '@helpdock/db';
import {
  createJobProcessor,
  type EmailSendPayload,
  emailSendJob,
  emailSendPayloadSchema,
  type JobHandler,
  type JobLogger,
} from '@helpdock/jobs';
import { EMAIL_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import type { EmailRepository } from './email.repository.js';
import { templatesFor } from './outgoing-settings.js';
import { renderDelivery } from './render-delivery.js';
import { brandSmtpServer, type InstallSmtp, type SmtpTransportFactory } from './transport.js';

/**
 * The `email.send` consumer (M2-05): one delivery row in, one SMTP
 * conversation out.
 *
 * **Idempotent** (DOMAIN-RULES §6, the M2 exit criterion "delivering the same
 * outbox job twice sends one email"). The receipt `email.send:<deliveryId>` is
 * claimed in the transaction that marks the row `sent`, so a second delivery
 * blocks on the first's insert and then finds it taken; and a row already
 * `sent` is skipped, which holds after receipts are purged. The one window left
 * — SMTP accepted, then the commit failed — resends with the same
 * `Message-ID`, which the customer's client files as the same message.
 *
 * **Failure** is recorded outside the job's transaction, which rolls back on a
 * throw: every attempt counts and keeps the relay's last words, and the last
 * attempt moves the row to `failed` — the Failed sends panel. The job itself
 * stays in BullMQ's failed set.
 */

export interface EmailSendDependencies {
  readonly repository: EmailRepository;
  readonly keyring: Keyring;
  readonly installSmtp: InstallSmtp;
  readonly transports: SmtpTransportFactory;
  readonly now?: () => Date;
}

/** Raised when there is nowhere to send through; retried, then dead-lettered. */
export class NoSmtpServerError extends Error {
  constructor() {
    super('No SMTP server is configured for this brand or the install.');
    this.name = 'NoSmtpServerError';
  }
}

export const createEmailSendHandler =
  ({
    repository,
    keyring,
    installSmtp,
    transports,
    now = () => new Date(),
  }: EmailSendDependencies): JobHandler<EmailSendPayload> =>
  async ({ payload, brandId, tx, log }) => {
    const delivery = await repository.delivery(tx, payload.deliveryId);
    // Only a queued send is sent. `sent` is a redelivery; `failed` and
    // `discarded` are an Admin's to put back, which sets `queued` first.
    if (delivery === undefined || delivery.status !== 'queued') {
      log.info(
        { brandId, deliveryId: payload.deliveryId, status: delivery?.status ?? null },
        'email.send skipped: nothing queued to send',
      );
      return;
    }

    const facts = await repository.sendFacts(tx, delivery);
    if (facts === undefined) {
      log.info({ brandId, deliveryId: delivery.id }, 'email.send skipped: the ticket is gone');
      return;
    }

    const settings = await repository.settings(tx, brandId);
    const server = brandSmtpServer(settings, keyring) ?? (await installSmtp.read())?.server;
    if (server === undefined) {
      throw new NoSmtpServerError();
    }

    const message = renderDelivery({
      delivery,
      facts,
      thread: await repository.threadIds(tx, delivery),
      templates: (kind) => templatesFor(settings, kind),
    });

    const transport = transports(server, {
      address: delivery.fromAddress,
      name: delivery.fromName,
    });
    try {
      await transport.send(message);
    } finally {
      transport.close();
    }

    await repository.markSent(tx, delivery.id, now());
    // The recipient and the Message-ID, never the body (REQUIREMENTS §5.1).
    log.info(
      { brandId, deliveryId: delivery.id, kind: delivery.kind, messageId: delivery.messageId },
      'email sent',
    );
  };

/** Whether this attempt is the job's last: BullMQ counts the ones before it. */
export const isLastAttempt = (job: Job, error: unknown): boolean =>
  error instanceof UnrecoverableError ||
  job.attemptsMade + 1 >= (job.opts.attempts ?? emailSendJob.options.attempts ?? 1);

export const createEmailSendProcessor = ({
  db,
  log,
  repository,
  handler,
  now = () => new Date(),
}: {
  readonly db: Db;
  readonly log: JobLogger;
  readonly repository: EmailRepository;
  readonly handler: JobHandler<EmailSendPayload>;
  readonly now?: () => Date;
}) => {
  const process = createJobProcessor(emailSendJob, handler, { db, log });

  return async (job: Job): Promise<void> => {
    try {
      await process(job);
    } catch (error) {
      const parsed = emailSendPayloadSchema.safeParse(job.data);
      if (parsed.success) {
        const dead = isLastAttempt(job, error);
        await withSystem(db, parsed.data.brandId, (tx) =>
          repository.recordFailure(tx, parsed.data.deliveryId, {
            attempts: job.attemptsMade + 1,
            error: describeSmtpError(error, EMAIL_ERROR_MAX_LENGTH),
            dead,
            at: now(),
          }),
        ).catch((recordError: unknown) => {
          log.error({ err: recordError, jobId: job.id }, 'could not record an email.send failure');
        });
      }
      throw error;
    }
  };
};

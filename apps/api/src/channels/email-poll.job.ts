import {
  type ImapConnectOptions,
  ImapFailure,
  parseRawEmail,
  pollImapFolder,
  recipientsOf,
} from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import { type Db, type Mailbox as MailboxRow, mailboxes } from '@helpdock/db';
import {
  emailPollJob,
  emailPollSchedulerId,
  type JobLogger,
  type OutboxEventHandler,
  parseJobPayload,
} from '@helpdock/jobs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { isBrandGone } from '../brands/brand-availability.js';
import { withSystemJob } from '../tenant/system-job.js';
import type { InboundEmailService } from './inbound/inbound-email.service.js';
import type { MailboxesRepository, MailboxLocator } from './mailboxes.repository.js';
import { MAILBOX_CHANGED_EVENT } from './mailboxes.service.js';

/**
 * The worker's half of M2-02: one `email.poll` tick for one mailbox, and the
 * job schedulers that make the ticks happen.
 *
 * A tick reads the mailbox in the brand's system context, signs in over IMAP
 * *outside* any transaction — a slow server must not hold a database
 * connection — and hands each new message to {@link InboundEmailService},
 * which opens a transaction of its own per message. The cursor and the health
 * columns are written last, in one more short transaction.
 *
 * A server that refuses or cannot be reached is **recorded, not thrown**: the
 * mailbox shows "IMAP sign-in failed" on the Channels list, and the next tick
 * tries again. A message the pipeline could not store *is* thrown, after the
 * cursor before it was saved, so the job lands in the failed set where the
 * queue dashboard shows it and the next tick retries that message.
 */

export interface EmailPollDependencies {
  readonly db: Db;
  readonly log: JobLogger;
  readonly keyring: Keyring;
  readonly repository: MailboxesRepository;
  readonly inbound: InboundEmailService;
  readonly imap: ImapConnectOptions;
  readonly now?: () => Date;
}

const jobIdFor = (mailboxId: string): string => `email.poll:${mailboxId}`;

const settingsOf = (mailbox: MailboxRow, keyring: Keyring) => {
  if (
    mailbox.method !== 'imap' ||
    mailbox.imapHost === null ||
    mailbox.imapPort === null ||
    mailbox.imapSecurity === null ||
    mailbox.imapUsername === null ||
    mailbox.imapPassword === null
  ) {
    return undefined;
  }

  return {
    host: mailbox.imapHost,
    port: mailbox.imapPort,
    security: mailbox.imapSecurity,
    username: mailbox.imapUsername,
    password: decryptSecret(mailbox.imapPassword, keyring),
    folder: mailbox.imapFolder,
  };
};

export const createEmailPollProcessor =
  (deps: EmailPollDependencies) =>
  async (job: { readonly data: unknown }): Promise<void> => {
    const { brandId, mailboxId } = parseJobPayload(emailPollJob, job.data);
    const now = (deps.now ?? (() => new Date()))();
    // M8-07: a brand being deleted takes no more mail. The scheduler stays, so
    // a restore within the grace period picks up where polling stopped.
    if (await isBrandGone(deps.db, brandId)) {
      return;
    }
    const mailbox = await withSystemJob(deps.db, brandId, jobIdFor(mailboxId), (tx) =>
      deps.repository.row(tx, mailboxId),
    );
    const settings = mailbox === undefined ? undefined : settingsOf(mailbox, deps.keyring);
    if (mailbox === undefined || settings === undefined) {
      // Deleted or switched to inbound parse since the tick was scheduled; the
      // `mailbox.changed` handler removes the scheduler.
      return;
    }

    let result: Awaited<ReturnType<typeof pollImapFolder>>;
    try {
      result = await pollImapFolder(
        settings,
        { uidValidity: mailbox.imapUidValidity, lastUid: mailbox.imapLastUid },
        async (raw) => {
          const email = await parseRawEmail(raw).catch((error: unknown) => {
            // A message mailparser cannot read will not read better next time.
            deps.log.warn(
              { mailboxId, err: error },
              'an IMAP message could not be parsed; skipped',
            );
            return undefined;
          });
          if (email !== undefined) {
            await deps.inbound.receive(
              { brandId, mailboxId },
              { email, recipients: recipientsOf(email) },
            );
          }
        },
        {
          ...deps.imap,
          onSkipped: (uid, size) => {
            deps.log.warn(
              { mailboxId, uid, size },
              'an IMAP message is over the size cap; skipped',
            );
          },
        },
      );
    } catch (error) {
      const failure =
        error instanceof ImapFailure ? error : new ImapFailure('connect', null, error);
      deps.log.warn({ mailboxId, kind: failure.kind }, 'IMAP poll failed');
      await record(deps, brandId, mailboxId, {
        lastPolledAt: now,
        lastError: failure.serverResponse ?? failure.kind,
        lastErrorKind: failure.kind === 'timeout' ? 'connect' : failure.kind,
        lastErrorAt: now,
      });
      return;
    }

    await record(deps, brandId, mailboxId, {
      imapUidValidity: result.uidValidity,
      imapLastUid: result.lastUid,
      lastPolledAt: now,
      ...(result.handlerError === null
        ? { lastSuccessAt: now, lastError: null, lastErrorKind: null, lastErrorAt: null }
        : {}),
    });

    if (result.handlerError !== null) {
      throw result.handlerError;
    }
  };

const record = async (
  deps: EmailPollDependencies,
  brandId: string,
  mailboxId: string,
  values: Partial<MailboxRow>,
): Promise<void> => {
  await withSystemJob(deps.db, brandId, jobIdFor(mailboxId), async (tx) => {
    await tx.update(mailboxes).set(values).where(eq(mailboxes.id, mailboxId));
  });
};

// --------------------------------------------------------------------------
// Scheduling
// --------------------------------------------------------------------------

/** What scheduling needs of BullMQ. The worker passes a queue; a test passes a double. */
export interface PollScheduler {
  upsert(mailbox: Pick<MailboxLocator, 'id' | 'brandId' | 'pollIntervalSeconds'>): Promise<void>;
  remove(mailboxId: string): Promise<void>;
}

/** Over a BullMQ `Queue` on the `inbound` queue. */
export const queuePollScheduler = (queue: {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: unknown; opts: object },
  ): Promise<unknown>;
  removeJobScheduler(id: string): Promise<unknown>;
}): PollScheduler => ({
  upsert: async (mailbox) => {
    await queue.upsertJobScheduler(
      emailPollSchedulerId(mailbox.id),
      { every: mailbox.pollIntervalSeconds * 1_000 },
      {
        name: emailPollJob.name,
        data: { brandId: mailbox.brandId, mailboxId: mailbox.id },
        opts: emailPollJob.options,
      },
    );
  },
  remove: async (mailboxId) => {
    await queue.removeJobScheduler(emailPollSchedulerId(mailboxId));
  },
});

const mailboxChangedSchema = z.object({ mailboxId: z.uuid() });

/**
 * `mailbox.changed` (written by `MailboxesService` with every create, edit and
 * delete): reads the row as it now is and makes the scheduler agree. Upsert and
 * remove are both idempotent, so a redelivered event changes nothing.
 */
export const createMailboxChangedHandler =
  (repository: MailboxesRepository, scheduler: PollScheduler): OutboxEventHandler =>
  async ({ tx, payload }) => {
    const { mailboxId } = mailboxChangedSchema.parse(payload);
    const mailbox = await repository.row(tx, mailboxId);

    if (mailbox?.method === 'imap') {
      await scheduler.upsert(mailbox);
    } else {
      await scheduler.remove(mailboxId);
    }
  };

export { MAILBOX_CHANGED_EVENT };

/** Every IMAP mailbox's scheduler, again, on worker boot (DOMAIN-RULES §10). */
export const scheduleAllPollers = async (
  db: Db,
  repository: MailboxesRepository,
  scheduler: PollScheduler,
): Promise<number> => {
  const pollable = await repository.listPollable(db);
  for (const mailbox of pollable) {
    await scheduler.upsert(mailbox);
  }

  return pollable.length;
};

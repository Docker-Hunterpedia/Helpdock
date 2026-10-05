import type { EmailMessage, EmailSender } from '@helpdock/channels';
import { decryptSecret, type Keyring, SecretDecryptionError } from '@helpdock/config';
import { type Db, type DbTransaction, type User, users } from '@helpdock/db';
import {
  type AuthEmailPayload,
  authEmailJob,
  authEmailJobId,
  createJobProcessor,
  type JobHandler,
  type JobLogger,
  type OutboxEventHandler,
  silentLogger,
} from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { authEmailEventSchema } from './auth-email.js';
import { renderAuthEmail } from './email-templates.js';

/**
 * The worker half of auth email. The `auth.email_requested` outbox handler
 * adds one `auth.email` job per row, and the job renders the message in the
 * recipient's language and sends it from the install's system sender — the
 * `smtp.*` settings the first-run wizard writes, the same sender staff
 * notifications use.
 *
 * **Once per request.** The job claims `auth.email:<outbox id>` in the
 * transaction it runs in, so a redelivered job finds the receipt and sends
 * nothing (DOMAIN-RULES §6).
 *
 * **Without SMTP** (a development install) the job logs that an email would
 * have been sent, naming the kind and the account but never the link: a
 * sign-in link is a credential, and the log is read by more people than the
 * mailbox is. Retrying cannot make an operator configure SMTP, so the job
 * finishes rather than failing.
 */

/** The install's system sender, or null without SMTP. `InstallChannels` in the worker. */
export interface SystemSenderSource {
  systemSender(): Promise<EmailSender | null>;
}

export interface AuthEmailWorkerDeps {
  readonly senders: SystemSenderSource;
  readonly keyring: Keyring;
}

/** Adds an `auth.email` job. The worker passes BullMQ; tests pass a recorder. */
export interface AuthEmailQueue {
  add(jobId: string, payload: AuthEmailPayload): Promise<void>;
}

export const createAuthEmailEventHandler =
  (queue: AuthEmailQueue): OutboxEventHandler =>
  async ({ outboxId, brandId, payload }) => {
    const event = authEmailEventSchema.parse(payload);

    await queue.add(authEmailJobId(outboxId), { ...event, brandId, sourceOutboxId: outboxId });
  };

/** The message one job sends. Also what the integration suites read a link back out of. */
export const composeAuthEmail = (
  payload: Pick<AuthEmailPayload, 'kind' | 'urlEncrypted' | 'expiresIn' | 'values'>,
  recipient: Pick<User, 'email' | 'name' | 'locale'>,
  keyring: Keyring,
): EmailMessage =>
  renderAuthEmail({
    kind: payload.kind,
    to: recipient.email,
    name: recipient.name,
    url: decryptSecret(payload.urlEncrypted, keyring),
    locale: recipient.locale,
    ...(payload.expiresIn === undefined ? {} : { expiresIn: payload.expiresIn }),
    ...(payload.values === undefined ? {} : { values: payload.values }),
  });

const recipientOf = async (tx: DbTransaction, userId: string): Promise<User | undefined> => {
  const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);

  return row;
};

export const createAuthEmailHandler =
  ({ senders, keyring }: AuthEmailWorkerDeps): JobHandler<AuthEmailPayload> =>
  async ({ payload, tx, log }) => {
    const facts = { job: authEmailJob.name, kind: payload.kind, userId: payload.userId };

    // Read now rather than when the link was asked for: an account deactivated
    // in between must not receive a way back in (DOMAIN-RULES §12).
    const recipient = await recipientOf(tx, payload.userId);
    if (
      recipient === undefined ||
      recipient.status === 'deactivated' ||
      recipient.deactivatedAt !== null
    ) {
      log.info(facts, 'Auth email not sent: the account is gone or deactivated.');
      return;
    }

    let message: EmailMessage;
    try {
      message = composeAuthEmail(payload, recipient, keyring);
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        // A master key that changed without the rotation procedure. No retry
        // can open the envelope, and the message names the envelope, not its
        // contents.
        throw new UnrecoverableError(
          `The auth email link could not be decrypted: ${error.message}`,
        );
      }
      throw error;
    }

    const sender = await senders.systemSender();
    if (sender === null) {
      log.warn(
        { ...facts, locale: message.locale },
        'Auth email not sent: this install has no SMTP settings. It would have gone to the account named here.',
      );
      return;
    }

    await sender.send(message);
    log.info({ ...facts, locale: message.locale }, 'auth email sent');
  };

export const createAuthEmailProcessor = (
  deps: AuthEmailWorkerDeps,
  { db, log = silentLogger }: { readonly db: Db; readonly log?: JobLogger | undefined },
): ((job: Job) => Promise<void>) =>
  createJobProcessor(authEmailJob, createAuthEmailHandler(deps), { db, log });

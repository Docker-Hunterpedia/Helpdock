import {
  GraphApiFailure,
  type GraphClient,
  graphApiFor,
  graphMediaUploadSchema,
  graphSendResponseSchema,
  type MessagingSendPayload,
  parseGraph,
  splitMetaText,
  type WhatsAppSendPayload,
} from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import {
  type Attachment,
  type Db,
  type DbTransaction,
  type MetaAccount,
  type MetaConversation,
  type MetaDelivery,
  ticketMessages,
  withSystem,
} from '@helpdock/db';
import {
  createJobProcessor,
  isLastAttempt,
  type JobHandler,
  type JobLogger,
  type MetaSendPayload,
  metaSendJob,
  metaSendPayloadSchema,
} from '@helpdock/jobs';
import {
  type DownloadVariant,
  META_ATTACHMENT_LIMITS,
  META_ERROR_MAX_LENGTH,
  type MetaPlatform,
} from '@helpdock/schemas';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { objectKeyBeside } from '../media/keys.js';
import type { ObjectStorage } from '../media/storage.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import type { MetaRepository } from './meta.repository.js';
import {
  customerIsTold,
  type MetaFileMethod,
  outgoingFileName,
  planOutgoingFile,
  readOutgoingBytes,
  replyAttachments,
} from './meta-attachments.js';
import { holdRecipientPace, paceKey, RecipientPaceHeld, withRecipientPace } from './meta-pacing.js';
import { fileLeftOutText } from './meta-text.js';
import { conversationWindow, windowClosedCode } from './meta-window.js';
import { WINDOW_CLOSED_NOTE } from './outbound-meta.service.js';

/**
 * The `meta.send` consumer (M10-06): an agent's reply to a WhatsApp, Messenger
 * or Instagram customer (ADR 0025, 7 and 8).
 *
 * **Idempotent** (DOMAIN-RULES §6). The receipt `meta.send:<delivery>` is
 * claimed in the job's transaction, so a second delivery of the job sends
 * nothing; a reply no longer `queued` is skipped, which holds after receipts
 * are purged. A reply is several parts, the text cut at the platform's limit and
 * then each attachment as a message of its own, and each part Meta accepts is
 * recorded at once, in a transaction of its own, so a retry starts after the
 * last part that landed and the customer never reads a part twice.
 *
 * **The window is checked again** before the first part, because it can close
 * while the job waits in the queue: a reply that is past it is `refused` with
 * the platform's code and is never retried (DOMAIN-RULES §2.6). Whether it is
 * past is the one `replyWindow` function, never a clock of the job's own.
 *
 * **Pacing.** WhatsApp refuses a second message to one user inside six seconds,
 * so each part takes the customer's slot first (`meta-pacing.ts`). A part that
 * finds it held moves the job to delayed for the remainder and ends it with
 * BullMQ's `DelayedError`: no attempt is spent, the transaction rolls back, and
 * the next run resumes after the parts already recorded.
 *
 * **Failure** is recorded outside the job's transaction, which rolls back on a
 * throw, as `telegram.send` records it (the processor below), by what Graph
 * said (brief §1.3): a transient fault or a rate limit is retried; a refusal
 * retrying cannot change ends the job now, and a dead token also marks the
 * account `token_expired`.
 */

export interface MetaSendDependencies {
  readonly db: Db;
  readonly repository: MetaRepository;
  readonly keyring: Keyring;
  readonly graph: GraphClient;
  /** Where an agent's attachments are read from. */
  readonly storage: ObjectStorage;
  /** The pacing keys of WhatsApp live here. */
  readonly redis: Redis;
  /** The language a left-out file is explained in. */
  readonly locales: Pick<TicketLifecycleRepository, 'localeForContact'>;
  readonly now?: () => Date;
}

/** An attachment of the reply is not ready yet; retrying later is the answer. */
export class MetaFileNotReadyError extends Error {
  constructor() {
    super('An attachment of the reply is still being processed');
    this.name = 'MetaFileNotReadyError';
  }
}

/** Graph refused for good — the recipient, the token, a permission — so the job ends now. */
export class MetaSendRefusal extends UnrecoverableError {
  readonly failure: GraphApiFailure;

  constructor(failure: GraphApiFailure) {
    super(failure.detail);
    this.name = 'MetaSendRefusal';
    this.failure = failure;
  }
}

/**
 * The reply window is closed: by Helpdock's own reading before the first part,
 * or by Graph's (`131047`, or `10` with sub-code `2018278`) when the clocks
 * disagreed by a moment. Either way the delivery is `refused`, not `failed`.
 */
export class MetaWindowClosedError extends UnrecoverableError {
  readonly code: string;
  readonly detail: string;

  constructor(platform: MetaPlatform, failure?: GraphApiFailure) {
    const detail = failure?.detail ?? WINDOW_CLOSED_NOTE;
    super(detail);
    this.name = 'MetaWindowClosedError';
    this.detail = detail;
    this.code = failure === undefined ? windowClosedCode(platform) : codeLabel(failure);
  }
}

/** `190`, or `10/2018278` with a sub-code: how `last_error` and the thread write Graph's code. */
const codeLabel = (failure: Pick<GraphApiFailure, 'code' | 'subcode'>): string =>
  failure.subcode === null
    ? String(failure.code ?? '')
    : `${String(failure.code ?? '')}/${String(failure.subcode)}`;

// ---------------------------------------------------------------- the couriers

/** One file as a courier sends it. */
interface OutgoingFile {
  readonly row: Attachment;
  readonly method: MetaFileMethod;
  readonly variant: DownloadVariant;
  readonly size: number;
  readonly mime: string;
  readonly fileName: string;
}

/** What a platform is asked to carry: text, or one file. Each answers the id it gave the message. */
interface Courier {
  text(text: string): Promise<string>;
  file(file: OutgoingFile): Promise<string>;
}

const clip = (text: string, max: number): string => [...text].slice(0, max).join('');

interface CourierContext {
  readonly deps: MetaSendDependencies;
  readonly account: MetaAccount;
  readonly conversation: MetaConversation;
  readonly delivery: MetaDelivery;
  readonly token: string;
}

const postSend = async (
  { deps, account, token }: CourierContext,
  payload: WhatsAppSendPayload | MessagingSendPayload,
): Promise<string> =>
  parseGraph(
    graphSendResponseSchema,
    await deps.graph.post(`/${account.externalId}/messages`, {
      token,
      api: graphApiFor(account.platform),
      json: payload,
    }),
    'a send',
    token,
  );

/**
 * WhatsApp: the number when Meta sent one, else the business-scoped user id
 * (`recipient`, from July 2026). A file is uploaded to `/{phone-number-id}/media`
 * first and sent by the id that returns, rather than handing Meta a link into
 * the bucket (ADR 0025, 7).
 */
const whatsappCourier = (context: CourierContext): Courier => {
  const { deps, account, conversation, delivery, token } = context;
  const addressee =
    conversation.waId === null
      ? ({ recipient: delivery.customerId } as const)
      : ({ to: conversation.waId } as const);
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...addressee,
  } as const;

  return {
    text: (text) => postSend(context, { ...base, type: 'text', text: { body: text } }),
    file: async (file) => {
      // The ceiling is the platform's largest, not the size the row claims.
      const bytes = await readOutgoingBytes(
        deps.storage,
        file.row,
        file.variant,
        META_ATTACHMENT_LIMITS.whatsapp.file,
      );
      const uploaded = parseGraph(
        graphMediaUploadSchema,
        await deps.graph.postMultipart(`/${account.externalId}/media`, {
          token,
          fields: { messaging_product: 'whatsapp', type: file.mime },
          file: { name: file.fileName, contentType: file.mime, bytes },
        }),
        'a media upload',
        token,
      );
      const { id } = uploaded;
      switch (file.method) {
        case 'image':
          return postSend(context, {
            ...base,
            type: 'image',
            image: { id, caption: clip(file.fileName, 1_024) },
          });
        case 'video':
          return postSend(context, {
            ...base,
            type: 'video',
            video: { id, caption: clip(file.fileName, 1_024) },
          });
        case 'audio':
          return postSend(context, { ...base, type: 'audio', audio: { id } });
        case 'document':
          return postSend(context, {
            ...base,
            type: 'document',
            document: { id, filename: clip(file.fileName, 240) },
          });
      }
    },
  };
};

/**
 * Messenger on `graph.facebook.com` and Instagram on `graph.instagram.com`: the
 * same payload. `RESPONSE`, because every reply here answers the customer's
 * message inside the window; `metadata` carries the delivery id so the echo of
 * Helpdock's own send can be told from a message typed in the Page inbox
 * (M10-04, M10-05). A file is handed over as a five-minute presigned link, so
 * the bucket's host must be one Meta can reach (the guide says so).
 *
 * M10-09 adds `MESSAGE_TAG` with `HUMAN_AGENT` for a person's reply in the
 * extended window; until then such a reply goes out as `RESPONSE`, which Meta
 * refuses with the closed-window error, and the delivery ends `refused`.
 */
const messagingCourier = (context: CourierContext): Courier => {
  const { deps, delivery } = context;
  const envelope = {
    recipient: { id: delivery.customerId },
    messaging_type: 'RESPONSE',
  } as const;
  const metadata = delivery.id;

  return {
    text: (text) => postSend(context, { ...envelope, message: { text, metadata } }),
    file: async (file) => {
      const link = await deps.storage.presignDownload({
        key: objectKeyBeside(file.row.s3Key, file.variant),
        contentType: file.mime,
        fileName: file.fileName,
        inline: false,
      });
      return postSend(context, {
        ...envelope,
        message: {
          attachment: {
            type: file.method === 'document' ? 'file' : file.method,
            payload: { url: link.url, is_reusable: false },
          },
          metadata,
        },
      });
    },
  };
};

// -------------------------------------------------------------------- the job

/**
 * The step the job takes next, as a closure: `null` is a part that left nothing
 * to send, so the index of every part stays where it was between attempts.
 */
type Part = () => Promise<string | null>;

export const createMetaSendHandler =
  (deps: MetaSendDependencies): JobHandler<MetaSendPayload> =>
  async ({ payload, tx, log, job, token }) => {
    if (payload.kind !== 'reply') {
      // M10-09 adds template sends; nothing enqueues one before then.
      throw new UnrecoverableError(`meta.send does not handle a ${payload.kind} yet`);
    }
    await sendReply(deps, tx, { payload, log, job, token });
  };

const sendReply = async (
  deps: MetaSendDependencies,
  tx: DbTransaction,
  {
    payload,
    log,
    job,
    token,
  }: {
    readonly payload: MetaSendPayload;
    readonly log: JobLogger;
    readonly job: Job;
    readonly token: string | undefined;
  },
): Promise<void> => {
  const delivery = await deps.repository.delivery(tx, payload.deliveryId);
  // Only a queued reply is sent; `failed` is put back by Retry, which sets `queued` first.
  if (delivery === undefined || delivery.status !== 'queued') {
    log.info(
      {
        brandId: payload.brandId,
        deliveryId: payload.deliveryId,
        status: delivery?.status ?? null,
      },
      'meta.send skipped: nothing queued to send',
    );
    return;
  }

  const account = await deps.repository.account(tx, delivery.accountId);
  const conversation = await deps.repository.conversation(
    tx,
    delivery.accountId,
    delivery.customerId,
  );
  const [message] = await tx
    .select({ bodyText: ticketMessages.bodyText, authorType: ticketMessages.authorType })
    .from(ticketMessages)
    .where(eq(ticketMessages.id, delivery.ticketMessageId))
    .limit(1);
  /* c8 ignore next 3 -- each cascade-deletes the delivery with it. */
  if (account === undefined || conversation === undefined || message === undefined) {
    return;
  }
  const { platform } = account;

  // Only before the first part: a window that closes between two parts is Meta's
  // to refuse, and a half-sent reply is not turned into a refused one by a clock.
  if (delivery.partsSent === 0) {
    const window = conversationWindow({
      conversation,
      account,
      personAuthored: message.authorType === 'staff',
      now: (deps.now ?? (() => new Date()))(),
    });
    if (window.state === 'closed') {
      throw new MetaWindowClosedError(platform);
    }
  }

  const context: CourierContext = {
    deps,
    account,
    conversation,
    delivery,
    token: decryptSecret(account.accessToken, deps.keyring),
  };
  const courier = platform === 'whatsapp' ? whatsappCourier(context) : messagingCourier(context);
  const files = await replyAttachments(tx, delivery.ticketMessageId);

  // Every attachment is a part, sent, replaced by a notice or left out, so a
  // part's index never moves between attempts.
  const parts: Part[] = [
    ...splitMetaText(message.bodyText, platform).map(
      (text): Part =>
        () =>
          courier.text(text),
    ),
    ...files.map(
      (file): Part =>
        async () => {
          const plan = planOutgoingFile(file, platform);
          if (plan.kind === 'wait') {
            throw new MetaFileNotReadyError();
          }
          if (plan.kind === 'skip') {
            log.info(
              {
                brandId: payload.brandId,
                deliveryId: delivery.id,
                attachmentId: file.id,
                reason: plan.reason,
              },
              'meta reply: an attachment cannot be sent and is left out',
            );
            return customerIsTold(plan.reason)
              ? courier.text(
                  fileLeftOutText({
                    locale: await deps.locales.localeForContact(
                      tx,
                      payload.brandId,
                      conversation.contactId,
                    ),
                    platform,
                    name: file.originalName,
                    reason: plan.reason,
                    isFile: file.kind === 'file',
                  }),
                )
              : null;
          }
          return courier.file({
            row: file,
            method: plan.method,
            variant: plan.variant,
            size: plan.size,
            mime: plan.mime,
            fileName: outgoingFileName(file, plan.variant),
          });
        },
    ),
  ];

  const key = paceKey(account.id, delivery.customerId);
  for (const part of parts.slice(delivery.partsSent)) {
    const sentId = await runPart(part, { deps, platform, key, job, token, log });
    await withSystem(deps.db, payload.brandId, (partTx) =>
      deps.repository.recordPart(partTx, delivery.id, sentId),
    );
  }

  await deps.repository.markSent(tx, delivery.id, (deps.now ?? (() => new Date()))());
  log.info(
    { brandId: payload.brandId, deliveryId: delivery.id, platform, parts: parts.length },
    'meta reply sent',
  );
};

/**
 * One part, under the customer's pace on WhatsApp, with what Graph said turned
 * into what the job does (brief §1.3):
 *
 * | Graph said | The job |
 * |---|---|
 * | `retry`, `rate_limited` | throws the failure; BullMQ retries (`131056` sets the pace first) |
 * | `window_closed` | `refused`, never retried |
 * | `permanent`, `permission`, `account_restricted`, `token_dead` | ends at once |
 *
 * A held pace is not a failure: the job moves itself to delayed.
 */
const runPart = async (
  part: Part,
  {
    deps,
    platform,
    key,
    job,
    token,
    log,
  }: {
    readonly deps: MetaSendDependencies;
    readonly platform: MetaPlatform;
    readonly key: string;
    readonly job: Job;
    readonly token: string | undefined;
    readonly log: JobLogger;
  },
): Promise<string | null> => {
  try {
    return platform === 'whatsapp' ? await withRecipientPace(deps.redis, key, part) : await part();
  } catch (error) {
    if (error instanceof RecipientPaceHeld) {
      await job.moveToDelayed(Date.now() + error.remainingMs, token);
      log.info({ jobId: job.id, waitMs: error.remainingMs }, 'meta.send waits for the pair limit');
      throw new DelayedError();
    }
    if (!(error instanceof GraphApiFailure)) {
      throw error;
    }
    switch (error.kind) {
      case 'retry':
        throw error;
      case 'rate_limited':
        if (error.code === 131_056 && platform === 'whatsapp') {
          await holdRecipientPace(deps.redis, key);
        }
        throw error;
      case 'window_closed':
        throw new MetaWindowClosedError(platform, error);
      case 'permanent':
      case 'permission':
      case 'account_restricted':
      case 'token_dead':
        throw new MetaSendRefusal(error);
    }
  }
};

// ------------------------------------------------------------------ the failures

/** What a failed attempt shows on the delivery: Graph's own words when it spoke, else a plain line. */
const describeFailure = (
  error: unknown,
): {
  readonly text: string;
  readonly code: string | null;
  readonly graph: GraphApiFailure | null;
} => {
  const graph =
    error instanceof MetaSendRefusal
      ? error.failure
      : error instanceof GraphApiFailure
        ? error
        : null;
  if (graph !== null) {
    return {
      text: graph.detail,
      code: graph.code === null ? null : codeLabel(graph),
      graph,
    };
  }
  if (error instanceof MetaWindowClosedError) {
    return { text: error.detail, code: error.code, graph: null };
  }

  return {
    text: error instanceof MetaFileNotReadyError ? error.message : 'The reply could not be sent',
    code: null,
    graph: null,
  };
};

export const createMetaSendProcessor = ({
  db,
  log,
  repository,
  handler,
  now = () => new Date(),
}: {
  readonly db: Db;
  readonly log: JobLogger;
  readonly repository: MetaRepository;
  readonly handler: JobHandler<MetaSendPayload>;
  readonly now?: () => Date;
}) => {
  const process = createJobProcessor(metaSendJob, handler, { db, log });

  return async (job: Job, token?: string): Promise<void> => {
    try {
      await process(job, token);
    } catch (error) {
      // Moving to delayed is a wait, not a failure: nothing is recorded.
      if (error instanceof DelayedError) {
        throw error;
      }
      const parsed = metaSendPayloadSchema.safeParse(job.data);
      if (parsed.success && parsed.data.kind === 'reply') {
        const { brandId, deliveryId } = parsed.data;
        await withSystem(db, brandId, async (tx) => {
          const delivery = await repository.delivery(tx, deliveryId);
          if (delivery !== undefined) {
            await recordSendFailure({ repository, tx, delivery, error, job, at: now() });
          }
        }).catch((recordError: unknown) => {
          log.error({ err: recordError, jobId: job.id }, 'could not record a meta.send failure');
        });
      }
      throw error;
    }
  };
};

export const recordSendFailure = async ({
  repository,
  tx,
  delivery,
  error,
  job,
  at,
}: {
  readonly repository: MetaRepository;
  readonly tx: DbTransaction;
  readonly delivery: MetaDelivery;
  readonly error: unknown;
  readonly job: Job;
  readonly at: Date;
}): Promise<void> => {
  const { text, code, graph } = describeFailure(error);
  const clipped = text.slice(0, META_ERROR_MAX_LENGTH);

  if (error instanceof MetaWindowClosedError) {
    // The window, not the account: nothing is wrong with the connection.
    await repository.markRefused(tx, delivery.id, { errorCode: code, error: clipped, at });
    return;
  }

  await repository.recordFailure(tx, delivery.id, {
    attempts: job.attemptsMade + 1,
    error: clipped,
    errorCode: code,
    dead: isLastAttempt(metaSendJob, job, error),
    at,
  });
  if (graph?.kind === 'token_dead') {
    // Meta no longer knows the token: an Admin pastes a new one (ADR 0025, 10).
    await repository.update(tx, delivery.accountId, {
      status: 'token_expired',
      lastError: clipped,
      lastErrorAt: at,
    });
  } else if (graph !== null) {
    await repository.markError(tx, delivery.accountId, clipped, at);
  }
};

import {
  type Ai,
  AUTO_REPLY_HISTORY_TURNS,
  detectLocale,
  type KnowledgeLocale,
} from '@helpdock/ai';
import { type Db, type DbTransaction, nextMessageSeq } from '@helpdock/db';
import {
  type AiAutoReplyPayload,
  aiAutoReplyJob,
  claimReceipt,
  idempotencyKeyFor,
  type JobLogger,
  parseJobPayload,
} from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import type { RetrievedChunk, Retriever } from '../../knowledge/retrieval/retrieve.js';
import { withSystemJob } from '../../tenant/system-job.js';
import type { LifecycleResponseEvent } from '../../tickets/lifecycle/hooks.js';
import type { ReplyDeliveryHook } from '../../tickets/reply-delivery.hook.js';
import { writeTicketActivity } from '../../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../../tickets/ticket-events.js';
import { TicketRepository } from '../../tickets/tickets.repository.js';
import { aiMeta, type StoredAiMeta, type StoredCitation } from './ai-meta.js';
import { isAiPaused, pauseAi } from './ai-pause.js';
import { answerBody } from './answer-body.js';
import { AutoReplyRepository, type ConversationRow } from './auto-reply.repository.js';
import { type Generated, generateAutoReply } from './auto-reply-generate.js';
import type { AutoReplySettings, AutoReplySettingsReader } from './auto-reply-settings.js';

/**
 * `ai.auto_reply` (M7-06, REQUIREMENTS §4.7, DOMAIN-RULES §5 and §9): one
 * customer message answered from public knowledge, or the conversation handed
 * to the team.
 *
 * ```
 * brand tx      still open, not paused, channel on, still the newest message?
 * no tx         asks for a person?   → handoff (customer_request)
 *               retrieve (audience visitor) → complete → validate → confidence
 *               budget spent / no model → stop, silently
 * brand tx      receipt · lock the ticket · paused or superseded now? → stop
 *               answer: AI message, first response (§3.1), channel delivery
 *               handoff: the brand's handoff text, pause, channel delivery
 * ```
 *
 * The model call (`auto-reply-generate.ts`) runs outside any transaction, so
 * a slow provider holds no lock. That is why the pause is read twice: the
 * second read is under the ticket's row lock, which a staff reply and the
 * widget's "Talk to a human" take too, so a job that fires late — after a
 * handoff, an agent's reply or a newer message — sends nothing (DOMAIN-RULES
 * §9: "checked immediately before every send").
 */

export const AUTO_REPLY_ACTOR = 'ai:auto_reply';

export interface AutoReplyDeps {
  readonly db: Db;
  readonly ai: Pick<Ai, 'complete'>;
  readonly retriever: Retriever;
  readonly settings: AutoReplySettingsReader;
  /** Email and Telegram carry the message, exactly as they carry an agent's reply. */
  readonly delivery: Pick<ReplyDeliveryHook, 'onStaffPublicReply'>;
  /** M3-02's response clock: `SlaLifecycleHooks.onResponded`. */
  readonly responded: (tx: DbTransaction, event: LifecycleResponseEvent) => Promise<void>;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

interface Prepared {
  readonly conversation: ConversationRow;
  readonly messageSeq: number;
  readonly text: string;
  readonly locale: KnowledgeLocale;
  readonly settings: AutoReplySettings;
  readonly turns: readonly { from: 'customer' | 'assistant'; text: string }[];
}

const repository = new AutoReplyRepository();
const tickets = new TicketRepository();

export const createAutoReplyProcessor =
  (deps: AutoReplyDeps) =>
  (job: Job): Promise<void> | null => {
    if (job.name !== aiAutoReplyJob.name) {
      return null;
    }
    let payload: AiAutoReplyPayload;
    try {
      payload = parseJobPayload(aiAutoReplyJob, job.data);
    } catch (error) {
      throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
    }
    return runAutoReply(deps, payload, job.id ?? aiAutoReplyJob.name);
  };

export const runAutoReply = async (
  deps: AutoReplyDeps,
  payload: AiAutoReplyPayload,
  jobId: string,
): Promise<void> => {
  const now = deps.now ?? (() => new Date());
  const prepared = await withSystemJob(deps.db, payload.brandId, jobId, (tx) =>
    prepare(tx, deps, payload, now()),
  );
  if (prepared === null) {
    return;
  }

  const generated = await generateAutoReply(deps, {
    brandId: payload.brandId,
    ticketId: payload.ticketId,
    text: prepared.text,
    locale: prepared.locale,
    turns: prepared.turns,
    threshold: prepared.settings.threshold,
  });
  if (generated === null) {
    return;
  }

  await withSystemJob(deps.db, payload.brandId, jobId, async (tx) => {
    if (!(await claimReceipt(tx, idempotencyKeyFor(aiAutoReplyJob, payload, jobId)))) {
      return;
    }
    await nextMessageSeq(tx, payload.ticketId);
    const current = await repository.conversation(tx, payload.ticketId);
    const at = now();
    if (
      current === undefined ||
      !answerable(current, at) ||
      (await repository.supersededAfter(tx, payload.ticketId, prepared.messageSeq))
    ) {
      deps.log.info(
        { job: aiAutoReplyJob.name, ticketId: payload.ticketId },
        'auto-reply dropped: the conversation was handed off or moved on before it could send',
      );
      return;
    }
    await repository.markEligible(tx, payload.ticketId, at);
    await send(tx, deps, { payload, prepared, generated, conversation: current, at });
  });
};

const answerable = ({ ticket, status }: ConversationRow, at: Date): boolean =>
  status.systemState !== 'closed' &&
  ticket.mergedIntoId === null &&
  ticket.deletedAt === null &&
  !isAiPaused(ticket, at);

const prepare = async (
  tx: DbTransaction,
  deps: AutoReplyDeps,
  payload: AiAutoReplyPayload,
  at: Date,
): Promise<Prepared | null> => {
  const conversation = await repository.conversation(tx, payload.ticketId);
  if (conversation === undefined || !answerable(conversation, at)) {
    return null;
  }
  const settings = await deps.settings(tx, payload.brandId, conversation.ticket.channel);
  if (settings === null) {
    return null;
  }
  const message = await repository.message(tx, payload.messageId);
  if (
    message === undefined ||
    message.ticketId !== payload.ticketId ||
    message.kind !== 'public' ||
    message.authorType !== 'contact' ||
    message.bodyText.trim() === '' ||
    (await repository.supersededAfter(tx, payload.ticketId, message.seq))
  ) {
    return null;
  }
  const turns = await repository.turns(tx, payload.ticketId, message.seq, AUTO_REPLY_HISTORY_TURNS);
  return {
    conversation,
    messageSeq: message.seq,
    text: message.bodyText,
    locale: detectLocale(message.bodyText),
    settings,
    turns: turns.map((turn) => ({
      from: turn.authorType === 'ai' ? 'assistant' : 'customer',
      text: turn.bodyText,
    })),
  };
};

interface SendInput {
  readonly payload: AiAutoReplyPayload;
  readonly prepared: Prepared;
  readonly generated: Generated;
  readonly conversation: ConversationRow;
  readonly at: Date;
}

const send = async (tx: DbTransaction, deps: AutoReplyDeps, input: SendInput): Promise<void> => {
  const { payload, prepared, generated, conversation, at } = input;
  const { outcome } = generated;
  const common = {
    callId: generated.callId,
    model: generated.model,
    threshold: prepared.settings.threshold,
  };

  if (outcome.kind === 'answer') {
    const citations = citationsOf(outcome.decision.citations, generated.chunks);
    const body = answerBody(outcome.decision.text, citations, prepared.locale);
    await writeAiMessage(tx, deps, conversation, {
      html: body.html,
      text: body.text,
      meta: aiMeta('answer', {
        ...common,
        answer: outcome.decision.text,
        confidence: outcome.decision.confidence,
        citations,
      }),
    });
    await repository.markAnswered(tx, payload.ticketId, at);
    await deps.responded(tx, {
      brandId: payload.brandId,
      ticket: conversation.ticket,
      status: conversation.status,
      at,
      by: 'ai',
    });
    return;
  }

  if (outcome.withMessage) {
    const wording = prepared.settings.handoffMessage(prepared.locale);
    const body = answerBody(wording, [], prepared.locale);
    await writeAiMessage(tx, deps, conversation, {
      html: body.html,
      text: body.text,
      meta: aiMeta('handoff', {
        ...common,
        answer: wording,
        confidence: outcome.confidence,
        reason: outcome.reason,
      }),
    });
  }
  await pauseAi(tx, {
    brandId: payload.brandId,
    ticketId: payload.ticketId,
    reason: outcome.reason,
    at,
    actorId: AUTO_REPLY_ACTOR,
    ...(outcome.confidence === null
      ? {}
      : { confidence: outcome.confidence, threshold: prepared.settings.threshold }),
  });
  await enqueueTicketEvent(tx, payload.brandId, TICKET_EVENTS.updated, {
    ticketId: conversation.ticket.id,
    departmentId: conversation.ticket.departmentId,
  });
};

const citationsOf = (
  cited: readonly { marker: number; chunkId: string }[],
  chunks: readonly RetrievedChunk[],
): StoredCitation[] =>
  cited.flatMap(({ marker, chunkId }) => {
    const chunk = chunks.find((candidate) => candidate.chunkId === chunkId);
    return chunk === undefined
      ? []
      : [
          {
            marker,
            chunkId,
            title: chunk.title === '' ? chunk.sourceName : chunk.title,
            url: chunk.url,
            articleId: chunk.articleId,
            visibility: chunk.visibility,
          },
        ];
  });

/** The AI-authored public row, its activity, and the events that carry it to every channel. */
const writeAiMessage = async (
  tx: DbTransaction,
  deps: AutoReplyDeps,
  { ticket }: ConversationRow,
  message: { html: string; text: string; meta: StoredAiMeta },
): Promise<void> => {
  const seq = await tickets.nextSeq(tx, ticket.id);
  const row = await tickets.insertMessage(tx, {
    brandId: ticket.brandId,
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    seq,
    kind: 'ai',
    authorType: 'ai',
    authorId: AUTO_REPLY_ACTOR,
    bodyHtml: message.html,
    bodyText: message.text,
    channel: ticket.channel,
    aiMeta: message.meta,
  });
  await writeTicketActivity(tx, {
    brandId: ticket.brandId,
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    actor: { actorType: 'system', actorId: AUTO_REPLY_ACTOR, via: 'ai' },
    action: 'ticket.replied',
    to: { messageId: row.id, seq },
  });
  await tickets.updateTicket(tx, ticket.id, {});
  // The widget hears it through `ticket.replied`; email and Telegram queue
  // their delivery here, in this transaction, as for an agent's reply.
  await deps.delivery.onStaffPublicReply(tx, {
    brandId: ticket.brandId,
    ticket,
    messageId: row.id,
  });
  await enqueueTicketEvent(tx, ticket.brandId, TICKET_EVENTS.replied, {
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    messageId: row.id,
    seq,
    kind: 'ai',
  });
};

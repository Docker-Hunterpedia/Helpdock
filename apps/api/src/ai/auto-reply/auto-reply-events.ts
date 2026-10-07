import {
  type AiAutoReplyPayload,
  aiAutoReplyJobId,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
} from '@helpdock/jobs';
import { TICKET_EVENTS, ticketEventPayloadSchema } from '../../tickets/ticket-events.js';
import { isAiPaused } from './ai-pause.js';
import { AutoReplyRepository } from './auto-reply.repository.js';
import type { AutoReplySettingsReader } from './auto-reply-settings.js';

/**
 * How a customer message becomes an `ai.auto_reply` job (M7-06), through the
 * outbox like every side effect (DOMAIN-RULES §6): the inbound paths of the
 * widget, Telegram and email already write `ticket.created` and
 * `ticket.replied` in the transaction that stored the message, and this
 * subscriber adds the job after that commits.
 *
 * The job id is the message's, so the widget's start — which writes both
 * events for its first message — adds one job, and a redelivered event adds
 * nothing. What is checked here is only what saves a job: the job checks
 * everything again, twice.
 */

export const AUTO_REPLY_SUBSCRIBER = 'ai';

export interface AutoReplyQueue {
  add(payload: AiAutoReplyPayload, jobId: string): Promise<void>;
}

const repository = new AutoReplyRepository();

export const createAutoReplyEventHandler =
  (queue: AutoReplyQueue, settings: AutoReplySettingsReader): OutboxEventHandler =>
  async ({ tx, brandId, event, payload }) => {
    const parsed = ticketEventPayloadSchema.parse(payload);
    if (event === TICKET_EVENTS.replied && parsed.kind !== 'public') {
      return;
    }
    const conversation = await repository.conversation(tx, parsed.ticketId);
    if (
      conversation === undefined ||
      conversation.status.systemState === 'closed' ||
      isAiPaused(conversation.ticket, new Date()) ||
      (await settings(tx, brandId, conversation.ticket.channel)) === null
    ) {
      return;
    }
    const message =
      parsed.messageId === undefined
        ? await repository.latestCustomerMessage(tx, parsed.ticketId)
        : await repository.message(tx, parsed.messageId);
    if (message === undefined || message.authorType !== 'contact' || message.kind !== 'public') {
      return;
    }
    await queue.add(
      { brandId, ticketId: parsed.ticketId, messageId: message.id },
      aiAutoReplyJobId(message.id),
    );
  };

/** Called by the worker's start-up with the other handlers (`worker/start-worker.ts`). */
export const registerAutoReplyEventHandlers = (
  queue: AutoReplyQueue,
  settings: AutoReplySettingsReader,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  const handler = createAutoReplyEventHandler(queue, settings);
  for (const event of [TICKET_EVENTS.created, TICKET_EVENTS.replied]) {
    dispatcher.register(event, handler, AUTO_REPLY_SUBSCRIBER);
  }
};

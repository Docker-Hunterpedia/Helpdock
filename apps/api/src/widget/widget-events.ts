import { type OutboxEventHandler, registerEventHandler } from '@helpdock/jobs';
import { WIDGET_EVENTS } from '@helpdock/schemas';
import { TICKET_EVENTS, ticketEventPayloadSchema } from '../tickets/ticket-events.js';
import { resolveWidgetSettings } from './resolved-settings.js';
import { WidgetRepository } from './widget.repository.js';
import { conversationRoom, type WidgetBroadcast } from './widget-relay.js';
import { WidgetSettingsRepository } from './widget-settings.repository.js';
import { toWidgetConversation, toWidgetMessage } from './widget-view.js';

/**
 * The worker's half of M4-04: ticket events, after they commit, as widget
 * frames. Registered beside the staff handler for the same events under its
 * own subscriber, so neither's failure retries the other.
 *
 * - `ticket.replied` → `message`, with the message as a visitor sees it and
 *   its `seq`. Only public replies and AI answers: an internal note is never
 *   read here, so it cannot reach a visitor's socket even by mistake. This is
 *   also how an agent's reply "reaches the widget in real time".
 * - `ticket.closed`, `ticket.reopened`, `ticket.updated` → `conversation`
 *   (open or closed, continued or not) and `queue` (the position, or null once
 *   somebody holds it).
 *
 * A frame nobody is listening for is dropped by every replica's hub; REST is
 * the truth and the client catches up from its cursor (§7).
 */

export const WIDGET_SUBSCRIBER = 'widget';

export const createWidgetMessageHandler =
  (broadcast: WidgetBroadcast): OutboxEventHandler =>
  async ({ tx, brandId, payload }) => {
    const parsed = ticketEventPayloadSchema.parse(payload);
    if (parsed.messageId === undefined || (parsed.kind !== 'public' && parsed.kind !== 'ai')) {
      return;
    }

    const widget = new WidgetRepository();
    const row = await widget.message(tx, parsed.messageId);
    if (row === undefined || (row.kind !== 'public' && row.kind !== 'ai')) {
      return;
    }
    const settings = resolveWidgetSettings(await new WidgetSettingsRepository().row(tx, brandId));
    const files = await widget.attachmentsOf(tx, [row.id]);
    const staffNames = await widget.staffNames(
      tx,
      row.authorType === 'staff' && row.authorId !== null ? [row.authorId] : [],
    );
    const message = toWidgetMessage(row, files.get(row.id) ?? [], {
      staffNames,
      showAgentIdentity: settings.conversation.showAgentIdentity,
    });

    await broadcast.emit({
      room: conversationRoom(row.ticketId),
      event: WIDGET_EVENTS.message,
      data: message,
      seq: message.seq,
    });
  };

export const createWidgetConversationHandler =
  (broadcast: WidgetBroadcast): OutboxEventHandler =>
  async ({ tx, payload }) => {
    const parsed = ticketEventPayloadSchema.parse(payload);
    const widget = new WidgetRepository();
    const entry = await widget.conversation(tx, parsed.ticketId);
    // Every ticket is updated all day; only a widget conversation has anybody
    // in the widget to tell.
    if (entry === undefined || entry.ticket.channel !== 'chat') {
      return;
    }
    const continued = (await widget.continuations(tx, [entry.ticket.id])).get(entry.ticket.id);
    const view = toWidgetConversation(entry, 0, continued ?? null);
    const room = conversationRoom(entry.ticket.id);

    await broadcast.emit({
      room,
      event: WIDGET_EVENTS.conversation,
      data: { conversationId: view.id, state: view.state, continuedById: view.continuedById },
      seq: null,
    });
    await broadcast.emit({
      room,
      event: WIDGET_EVENTS.queue,
      data: { conversationId: view.id, position: await widget.queuePosition(tx, entry) },
      seq: null,
    });
  };

/** Called by the worker's start-up with the other handlers (`worker/start-worker.ts`). */
export const registerWidgetEventHandlers = (broadcast: WidgetBroadcast): void => {
  registerEventHandler(
    TICKET_EVENTS.replied,
    createWidgetMessageHandler(broadcast),
    WIDGET_SUBSCRIBER,
  );

  const conversation = createWidgetConversationHandler(broadcast);
  for (const event of [TICKET_EVENTS.closed, TICKET_EVENTS.reopened, TICKET_EVENTS.updated]) {
    registerEventHandler(event, conversation, WIDGET_SUBSCRIBER);
  }
};

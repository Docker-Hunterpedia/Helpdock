import type {
  NotificationKind,
  NotificationSounds,
  SoundEvent,
  Ticket,
  TicketMessage,
} from '@helpdock/schemas';

/**
 * Which sound a happening earns, as pure functions so the choice is testable
 * without a socket (M14-25). Each answers `null` for "play nothing": the
 * person's own actions, anything the person switched off, and anything that is
 * not news to a person who is not already looking at it.
 */

/** An unassigned, live chat nobody has picked up: what "waiting for an agent" means. */
export const isWaitingChat = (ticket: Ticket): boolean =>
  ticket.channel === 'chat' &&
  ticket.assigneeId === null &&
  ticket.mergedIntoId === null &&
  (ticket.status.systemState === 'open' || ticket.status.systemState === 'escalated');

/**
 * A ticket that has just been created. A manual ticket is somebody typing it in
 * on the desk, most often this person, so it is silent.
 */
export const soundForCreatedTicket = (ticket: Ticket): SoundEvent | null => {
  if (isWaitingChat(ticket)) {
    return 'waitingChat';
  }

  return ticket.channel === 'manual' ? null : 'newConversation';
};

/**
 * A customer's message on a ticket that is this person's. The opening message
 * of a conversation is the "new conversation" sound's, not a reply, and what
 * staff, a rule or the assistant wrote is never a customer replying.
 */
export const isCustomerReplyForMe = (
  ticket: Ticket,
  message: TicketMessage,
  selfId: string,
): boolean =>
  message.kind === 'public' &&
  message.authorType === 'contact' &&
  message.seq > 1 &&
  ticket.assigneeId === selfId;

export const soundForNotificationKind = (kind: NotificationKind): SoundEvent | null =>
  kind === 'assigned' || kind === 'mentioned' ? 'assignedOrMentioned' : null;

/** The person's own switch for an event. */
export const isSoundOn = (sounds: NotificationSounds, event: SoundEvent): boolean => sounds[event];

/** The reminder only repeats the waiting-chat sound, so it needs both switches. */
export const remindsWhileWaiting = (sounds: NotificationSounds): boolean =>
  sounds.waitingChat && sounds.waitingChatReminder;

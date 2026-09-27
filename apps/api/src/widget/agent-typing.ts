import { WIDGET_EVENTS } from '@helpdock/schemas';
import type { StaffSocketOptions } from '../realtime/staff.gateway.js';
import { conversationRoom, type WidgetBroadcast } from './widget-relay.js';

/**
 * M4-04's agent typing, from what `/staff` already hears: an agent with the
 * composer open announces `replying` on the ticket (M1-09's collision
 * indicator), and stops with `viewing`. The widget shows "typing" for the
 * first and clears it on the second; a room nobody watches drops the frame.
 *
 * The agent's name is not carried: the announcement names a user id, and the
 * widget shows a first name only on messages the brand chose to sign.
 *
 * Fire and forget, like every ephemeral event (§7): a failed publish is a
 * typing dot that did not appear.
 */
export const agentTypingRelay =
  (broadcast: WidgetBroadcast): NonNullable<StaffSocketOptions['onViewing']> =>
  ({ ticketId, activity }) => {
    void broadcast
      .emit({
        room: conversationRoom(ticketId),
        event: WIDGET_EVENTS.typing,
        data: { conversationId: ticketId, typing: activity === 'replying', agentName: null },
        seq: null,
      })
      .catch(() => undefined);
  };

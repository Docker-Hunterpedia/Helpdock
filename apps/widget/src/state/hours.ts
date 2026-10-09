import type { Availability, ConversationHours, ConversationSummary } from '../transport/types.js';

/**
 * Whose hours the widget words the handoff line, the header and the strip by
 * (M7-06). Both are pure, so the three places that say "the team is away"
 * cannot read different sources.
 */

/**
 * The hours of the team answering the conversation, as the server judged
 * them; before the conversation has any (a server older than M7-06, or no
 * conversation yet), the brand's own opening from the config. `null` when
 * neither is known: the widget never guesses a time.
 */
export const teamHours = (
  conversation: Pick<ConversationSummary, 'hours'> | null,
  availability: Availability | null,
): ConversationHours | null => {
  if (conversation?.hours) {
    return conversation.hours;
  }
  return availability
    ? {
        open: availability.state !== 'closed',
        next_open_at: availability.next_open_at,
        timezone: availability.timezone,
      }
    : null;
};

export interface Closure {
  /** Null for a calendar that never opens. */
  readonly next_open_at: string | null;
  readonly timezone: string;
}

/**
 * When the team is closed until, or `null` while it is open: also when the
 * hours are unknown, and when the opening has already passed while the page
 * stayed open, because the hours were judged earlier than now.
 */
export const closedUntil = (hours: ConversationHours | null, now: Date): Closure | null => {
  if (hours === null || hours.open) {
    return null;
  }
  if (hours.next_open_at !== null && new Date(hours.next_open_at).getTime() <= now.getTime()) {
    return null;
  }
  return { next_open_at: hours.next_open_at, timezone: hours.timezone };
};

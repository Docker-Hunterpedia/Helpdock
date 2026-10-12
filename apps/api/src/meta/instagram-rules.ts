/**
 * The small decisions the Instagram inbound service makes, as functions of
 * their inputs so each is held to its edge cases in a unit test (M10-05).
 */

/** A reaction's emoji is one or two code points; a longer value is not one. */
export const REACTION_EMOJI_MAX_LENGTH = 32;

/**
 * The external id of the system line that marks a message unsent
 * (DOMAIN-RULES §4.8). A ticket message has no column to hold the mark, so the
 * line names its message in the one column that is unique per brand and
 * channel: the thread finds the message a line belongs to by this value, and a
 * redelivered `is_deleted` event finds its line already there.
 */
const UNSENT_PREFIX = 'unsent:';

export const unsentExternalId = (messageId: string): string => `${UNSENT_PREFIX}${messageId}`;

/** The prefix every such line's external id starts with, for a query that finds them. */
export const UNSENT_ID_PREFIX = UNSENT_PREFIX;

/** The `mid` a line's external id names, or null for an id that is not an unsent marker's. */
export const unsentMessageId = (externalId: string): string | null =>
  externalId.startsWith(UNSENT_PREFIX) && externalId.length > UNSENT_PREFIX.length
    ? externalId.slice(UNSENT_PREFIX.length)
    : null;

/**
 * When an event happened, for the reply window and the delivery's timestamps:
 * Meta's clock, never later than Helpdock's own, so a skewed or forged
 * timestamp cannot hold a window open into the future.
 */
export const instantOf = (reported: Date | null, now: Date): Date =>
  reported === null || reported > now ? now : reported;

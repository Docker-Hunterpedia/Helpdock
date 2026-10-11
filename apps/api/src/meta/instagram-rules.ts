/**
 * The small decisions the Instagram inbound service makes, as functions of
 * their inputs so each is held to its edge cases in a unit test (M10-05).
 */

/** How much of a quoted message a reply carries. */
export const QUOTE_MAX_LENGTH = 160;

/** A reaction's emoji is one or two code points; a longer value is not one. */
export const REACTION_EMOJI_MAX_LENGTH = 32;

/**
 * The external id of the system line that marks a message unsent
 * (DOMAIN-RULES §4.8). A ticket message has no column to hold the mark, so the
 * line names its message in the one column that is unique per brand and
 * channel: the thread finds the message a line belongs to by this value, and a
 * redelivered `is_deleted` event finds its line already there.
 */
export const unsentExternalId = (messageId: string): string => `unsent:${messageId}`;

/**
 * When an event happened, for the reply window and the delivery's timestamps:
 * Meta's clock, never later than Helpdock's own, so a skewed or forged
 * timestamp cannot hold a window open into the future.
 */
export const instantOf = (reported: Date | null, now: Date): Date =>
  reported === null || reported > now ? now : reported;

/**
 * A quoted message as the leading line of the reply that quotes it: one line,
 * cut at {@link QUOTE_MAX_LENGTH} code points, prefixed `> `. A quote the
 * quoted message itself opened with is dropped first, so a thread of replies
 * does not grow a staircase of them. An empty message (a file, a sticker) has
 * nothing to quote.
 */
export const quoteLine = (quoted: string): string => {
  const lines = quoted.split(/\r?\n/).map((line) => line.trim());
  const first = lines.findIndex((line) => line !== '' && !line.startsWith('>'));
  const own = first === -1 ? '' : lines.slice(first).join(' ').replace(/\s+/g, ' ').trim();
  if (own === '') {
    return '';
  }
  const points = [...own];

  return points.length > QUOTE_MAX_LENGTH
    ? `> ${points.slice(0, QUOTE_MAX_LENGTH).join('').trimEnd()}…`
    : `> ${own}`;
};

/**
 * Bounds on what one row may put on a page. The ticket page parses strict
 * schemas with hard limits; a row beyond them (a message body of megabytes from
 * an inbound mail or an import, a subject or file name longer than the intake
 * rules allow, a message with hundreds of files) is clipped here first, so one
 * oversized row never turns a page into a 500.
 *
 * Intake does cap some of these (API subjects at `TICKET_SUBJECT_MAX`, file
 * names at 255 by `safeFileName`), but not all: an inbound email's body and
 * subject, an imported ticket and a message's file count have no cap in common,
 * so the page does not rely on one.
 */
export const SUBJECT_MAX = 1000;
export const FILE_NAME_MAX = 255;
export const MESSAGE_TEXT_MAX = 200_000;
export const FILES_PER_MESSAGE_MAX = 50;

/** `text` cut to at most `max` UTF-16 units, never inside a surrogate pair, with an ellipsis when it was cut. */
export const clipText = (text: string, max: number): { text: string; clipped: boolean } => {
  if (text.length <= max) {
    return { text, clipped: false };
  }
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return { text: `${text.slice(0, end)}…`, clipped: true };
};

export const clipLine = (text: string, max: number): string => clipText(text, max).text;

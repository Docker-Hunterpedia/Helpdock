import { createHash } from 'node:crypto';
import { HC_FEEDBACK_COMMENT_MAX } from '@helpdock/schemas';

/**
 * The dedupe keys of views and votes (M5-08). Pure, so the rules can be read
 * and tested without a database.
 *
 * - A **visitor** is whatever key the caller identifies them by — a widget
 *   visitor id, the help center's visitor cookie — stored only as a SHA-256
 *   of the brand and the key, so the tables never hold a cookie or an id that
 *   could be matched against another brand's.
 * - A **day** is the UTC calendar date: one view per visitor per article per
 *   day, whatever the visitor's time zone.
 */

export const visitorHash = (brandId: string, visitorKey: string): string =>
  createHash('sha256').update(`${brandId}:${visitorKey}`).digest('hex');

export const viewDay = (now: Date): string => now.toISOString().slice(0, 10);

/** A comment trimmed and capped; an empty one is no comment. */
export const cleanComment = (comment: string | undefined): string | null => {
  const text = comment?.trim().slice(0, HC_FEEDBACK_COMMENT_MAX) ?? '';
  return text === '' ? null : text;
};

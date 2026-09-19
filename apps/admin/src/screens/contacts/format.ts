import type { ContactIdentity, ContactSummary } from '@helpdock/schemas';

/**
 * The small decisions the contact screens make about what to print. They are
 * here rather than inside a component so they can be read, and tested, without
 * rendering anything.
 */

/** DESIGN §6.3: a value that is not there is an em dash, never an empty cell. */
export const DASH = '—';

/**
 * A visitor id is a UUID, and a UUID is not something a person reads. The
 * artboard shows `Visitor 7f3a…c2`, which is enough to tell two apart in a
 * conversation and short enough to sit on a row.
 */
export const shortVisitorId = (value: string): string => {
  const compact = value.replaceAll('-', '');

  return compact.length <= 8 ? compact : `${compact.slice(0, 4)}…${compact.slice(-2)}`;
};

/** What an identifier reads as on a row: the value, or the shortened visitor id. */
export const identityLabel = (identity: ContactIdentity | null): string => {
  if (identity === null) {
    return DASH;
  }

  return identity.kind === 'visitor' ? shortVisitorId(identity.value) : identity.value;
};

/**
 * Whether a contact is an anonymous visitor: nothing but a visitor id, so
 * nobody has told us who they are. The row draws the dashed avatar ring and the
 * "anonymous" caption for these.
 */
export const isAnonymousVisitor = (contact: ContactSummary): boolean =>
  contact.channels.length === 1 && contact.channels[0] === 'visitor';

/** Initials for the avatar: at most two, from the first and last word. */
export const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words.at(-1) ?? '') : '';

  return `${[...first][0] ?? ''}${[...last][0] ?? ''}`.toUpperCase();
};

/** CSAT is a percentage the api sends as 0–100, or null when nobody rated. */
export const csatLabel = (csat: number | null): string =>
  csat === null ? DASH : `${Math.round(csat)}%`;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/**
 * A duration as the stat tile prints it: `2h 15m`, `45m`, `30s`. Latin digits
 * in both locales, as DESIGN §7 requires of timers and counts.
 */
export const durationLabel = (seconds: number | null): string => {
  if (seconds === null) {
    return DASH;
  }

  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }

  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.round((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);

  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
};

/** `1–50 of 412`, with the page the list is actually showing. */
export const pageRange = (
  offset: number,
  shown: number,
  total: number,
): { from: number; to: number; total: number } => ({
  from: total === 0 ? 0 : offset + 1,
  to: offset + shown,
  total,
});

import type { Locale } from '@helpdock/i18n';
import type { Mailbox, MailboxHealthState } from '@helpdock/schemas';

/**
 * Words and numbers for Channels › Mailboxes. Latin digits in both locales
 * (DESIGN §7), which is what `-u-nu-latn` asks `Intl` for.
 */

const numbering = (locale: Locale): string => (locale === 'ar' ? 'ar-u-nu-latn' : locale);

const STEPS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', Number.POSITIVE_INFINITY],
];

/** "12 seconds ago", "3 minutes ago". Never in the future: a skewed clock reads as "now". */
export const ago = (iso: string, now: number, locale: Locale): string => {
  let value = Math.max(0, Math.round((now - Date.parse(iso)) / 1_000));
  const format = new Intl.RelativeTimeFormat(numbering(locale), { numeric: 'auto' });

  for (const [unit, size] of STEPS) {
    if (value < size) {
      return format.format(-value, unit);
    }
    value = Math.floor(value / size);
  }

  /* c8 ignore next -- the last step is unbounded. */
  return format.format(-value, 'day');
};

/** "14:02": when a failure started, as the artboard writes it. */
export const clockTime = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(numbering(locale), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

/** "14 Sep": when a password was saved. */
export const shortDate = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(numbering(locale), { day: 'numeric', month: 'short' }).format(
    new Date(iso),
  );

/** DESIGN §2.1's hue for each state; `waiting` is the neutral of an offline presence dot. */
export const HEALTH_TOKEN: Readonly<
  Record<
    MailboxHealthState,
    'status.success' | 'status.warning' | 'status.danger' | 'text.disabled'
  >
> = {
  healthy: 'status.success',
  behind: 'status.warning',
  failing: 'status.danger',
  waiting: 'text.disabled',
};

/** The text colour a state's label is drawn in, when it is one to notice. */
export const HEALTH_TEXT: Readonly<
  Partial<Record<MailboxHealthState, 'status.warning.text' | 'status.danger.text'>>
> = {
  behind: 'status.warning.text',
  failing: 'status.danger.text',
};

/**
 * The catalog key of a mailbox's health label: the failure itself when there
 * is one ("IMAP sign-in failed"), otherwise the state's own word.
 */
export const healthLabelKey = (
  mailbox: Pick<Mailbox, 'health'>,
): `channels:health.${MailboxHealthState | 'auth' | 'connect' | 'folder'}` =>
  mailbox.health.state === 'failing' && mailbox.health.lastErrorKind !== null
    ? `channels:health.${mailbox.health.lastErrorKind}`
    : `channels:health.${mailbox.health.state}`;

/** Lines of the allow-list textarea to addresses, lower-cased, blanks dropped. */
export const allowlistLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== '');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const looksLikeEmail = (value: string): boolean => EMAIL.test(value.trim());

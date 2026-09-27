import { splitName } from '@helpdock/schemas';

/**
 * Wording helpers for the Macros tab (M3-06). Pure, so they are tested on
 * values.
 */

type Translate = (key: 'macros:list.never' | 'macros:list.justNow') => string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "12 min ago", "1 h ago", "Yesterday", "Never" — the Last used column. The
 * locale's own relative wording, so Arabic reads as Arabic rather than as an
 * English sentence with Arabic numerals.
 */
export const lastUsedLabel = (
  iso: string | null,
  locale: 'en' | 'ar',
  now: number,
  t: Translate,
): string => {
  if (iso === null) {
    return t('macros:list.never');
  }

  const ago = Math.max(0, now - Date.parse(iso));
  if (ago < MINUTE) {
    return t('macros:list.justNow');
  }

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (ago < HOUR) {
    return relative.format(-Math.floor(ago / MINUTE), 'minute');
  }
  if (ago < DAY) {
    return relative.format(-Math.floor(ago / HOUR), 'hour');
  }

  return relative.format(-Math.floor(ago / DAY), 'day');
};

/** The sample contact the editor previews with, the artboard's own. */
const SAMPLE_CONTACT = { name: 'Mona Khalil', email: 'mona@example.com' };
const SAMPLE_TICKET = 'HD-1042';

/**
 * What each placeholder becomes in the editor's picker and preview: a sample
 * contact and ticket, and the real brand and sender, since those two the
 * screen already knows.
 */
export const sampleValues = ({
  brand,
  agent,
}: {
  readonly brand: string;
  readonly agent: string;
}): ReadonlyMap<string, string> => {
  const { first, last } = splitName(SAMPLE_CONTACT.name);

  return new Map([
    ['contact.first_name', first],
    ['contact.last_name', last],
    ['contact.name', SAMPLE_CONTACT.name],
    ['contact.email', SAMPLE_CONTACT.email],
    ['ticket.number', SAMPLE_TICKET],
    ['brand.name', brand],
    ['agent.first_name', splitName(agent).first],
  ]);
};

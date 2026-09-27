import type { AuditLogQuery } from '@helpdock/schemas';

/**
 * The audit log page's wording and query helpers (M3-08). Pure, so they are
 * tested on values.
 */

export interface AuditFilters {
  readonly actor: string;
  /** '' is any action; `ticket.*` is a family. */
  readonly action: string;
  readonly targetType: string;
  /** '' is every brand, `install` the install-wide rows, else a brand id. */
  readonly brand: string;
  /** `YYYY-MM-DD` as the date input holds it, in the reader's time zone. */
  readonly from: string;
  readonly to: string;
}

export const NO_FILTERS: AuditFilters = {
  actor: '',
  action: '',
  targetType: '',
  brand: '',
  from: '',
  to: '',
};

/** The artboard's Action options, in its order. A family matches every verb under it. */
export const ACTION_OPTIONS = [
  'settings.updated',
  'install.scope.access',
  'ticket.*',
  'staff.*',
  'macro.*',
  'retention.*',
] as const;

/** The artboard's Target type options, as the `target_type` the rows carry (Staff is `user`). */
export const TARGET_OPTIONS = ['settings', 'ticket', 'contact', 'user', 'macro', 'tag'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of a `YYYY-MM-DD`, as an instant. */
const localDay = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const [, year, month, day] = match;

  return new Date(Number(year), Number(month) - 1, Number(day));
};

/**
 * The request for one page. The date range is the reader's whole days: `to`
 * is inclusive, so it runs to the last millisecond of that local day.
 */
export const queryOf = (
  filters: AuditFilters,
  cursor: string | null,
): Partial<Omit<AuditLogQuery, 'limit'>> => {
  const from = localDay(filters.from);
  const to = localDay(filters.to);

  return {
    ...(filters.actor.trim() === '' ? {} : { actor: filters.actor.trim() }),
    ...(filters.action === '' ? {} : { action: filters.action }),
    ...(filters.targetType === '' ? {} : { targetType: filters.targetType }),
    ...(filters.brand === '' ? {} : { brand: filters.brand }),
    ...(from === null ? {} : { from: from.toISOString() }),
    ...(to === null ? {} : { to: new Date(to.getTime() + DAY_MS - 1).toISOString() }),
    ...(cursor === null ? {} : { cursor }),
  };
};

export const hasFilters = (filters: AuditFilters): boolean =>
  Object.values(filters).some((value) => value !== '');

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * `2026-09-27 14:22:08` in the reader's time zone. Latin digits in both
 * languages: an audit time is read and compared like an id (DESIGN §7).
 */
export const auditStamp = (iso: string): string => {
  const at = new Date(iso);

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
    at.getHours(),
  )}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

/** `UTC+3`, `UTC-4:30`, `UTC` — what the Time column's heading names. */
export const utcOffsetLabel = (at: Date = new Date()): string => {
  const minutes = -at.getTimezoneOffset();
  if (minutes === 0) {
    return 'UTC';
  }
  const sign = minutes > 0 ? '+' : '-';
  const whole = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;

  return `UTC${sign}${whole}${rest === 0 ? '' : `:${pad(rest)}`}`;
};

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/Windows/, 'Windows'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Android/, 'Android'],
  [/Ubuntu/, 'Ubuntu'],
  [/Linux/, 'Linux'],
];

/**
 * "Firefox on Ubuntu", or null when the header names neither. A summary, not a
 * parser: the full string is one hover away, and an audit reader wants to tell
 * two sessions apart, not fingerprint a browser.
 */
export const userAgentSummary = (
  userAgent: string | null,
): { readonly browser: string; readonly system: string } | null => {
  if (userAgent === null) {
    return null;
  }
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];

  return browser === undefined || system === undefined ? null : { browser, system };
};

/** Two letters for the actor's avatar, from their name. */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

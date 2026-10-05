import type { Locale } from '@helpdock/i18n';
import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_RETRY_BASE_MS,
  type WebhookDelivery,
} from '@helpdock/schemas';

/**
 * Words and numbers for the Developers page (M8-01, M8-03). Latin digits in
 * both locales (DESIGN §7), which is what `-u-nu-latn` asks `Intl` for.
 */

const numbering = (locale: Locale): string => (locale === 'ar' ? 'ar-u-nu-latn' : locale);

/** What one delivery's last attempt came to, as the log's status column names it. */
export type DeliveryOutcome =
  | 'delivered'
  | 'http'
  | 'timeout'
  | 'refused'
  | 'redirect'
  | 'noAnswer'
  | 'queued'
  | 'skipped';

/** The `@helpdock/net` codes that mean "Helpdock would not connect there". */
const REFUSED = /^(destination-blocked|redirect-blocked|port-not-allowed|scheme-not-allowed)\b/;

export const deliveryOutcome = (
  delivery: Pick<WebhookDelivery, 'status' | 'attempts' | 'responseStatus' | 'error'>,
): DeliveryOutcome => {
  if (delivery.status === 'succeeded') {
    return 'delivered';
  }
  if (delivery.status === 'skipped') {
    return 'skipped';
  }
  if (delivery.attempts === 0) {
    return 'queued';
  }
  if (delivery.responseStatus !== null) {
    return 'http';
  }
  const error = delivery.error ?? '';
  if (REFUSED.test(error)) {
    return 'refused';
  }
  if (error.startsWith('timeout')) {
    return 'timeout';
  }
  return /redirect/i.test(error) ? 'redirect' : 'noAnswer';
};

/** Whether a delivery counts as failed for the log's filter: it is not, or not yet, delivered. */
export const deliveryFailed = (delivery: WebhookDelivery): boolean =>
  delivery.status === 'failed' ||
  delivery.status === 'skipped' ||
  (delivery.status === 'pending' && delivery.attempts > 0);

/** The wait before attempt `attempt` (2 and up): BullMQ's exponential backoff. */
export const retryDelayMs = (attempt: number): number =>
  WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 2);

/** When a pending delivery that has already failed once will be tried again. */
export const nextRetryAt = (delivery: WebhookDelivery): string | null => {
  if (
    delivery.status !== 'pending' ||
    delivery.attempts === 0 ||
    delivery.attempts >= WEBHOOK_DELIVERY_ATTEMPTS ||
    delivery.lastAttemptAt === null
  ) {
    return null;
  }
  return new Date(
    Date.parse(delivery.lastAttemptAt) + retryDelayMs(delivery.attempts + 1),
  ).toISOString();
};

/** "184 ms", "2.1 s". */
export const durationText = (ms: number, locale: Locale): string =>
  ms < 1000
    ? `${new Intl.NumberFormat(numbering(locale)).format(ms)} ms`
    : `${new Intl.NumberFormat(numbering(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000)} s`;

/** "97.9 %", or null when nothing finished in the window. */
export const successRate = (
  { total, succeeded }: { readonly total: number; readonly succeeded: number },
  locale: Locale,
): string | null =>
  total === 0
    ? null
    : new Intl.NumberFormat(numbering(locale), {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(succeeded / total);

const STEPS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', Number.POSITIVE_INFINITY],
];

/** "2 minutes ago", "in 23 minutes". */
export const relativeTime = (iso: string, now: number, locale: Locale): string => {
  const seconds = Math.round((Date.parse(iso) - now) / 1_000);
  const sign = Math.sign(seconds);
  let value = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(numbering(locale), { numeric: 'auto' });

  for (const [unit, size] of STEPS) {
    if (value < size) {
      return format.format(sign * value, unit);
    }
    value = Math.floor(value / size);
  }

  /* c8 ignore next -- the last step is unbounded. */
  return format.format(sign * value, 'day');
};

/** "14:02:11". */
export const clockSeconds = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(numbering(locale), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));

/** "2 Oct 18:20". */
export const dayAndTime = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(numbering(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

/** "12 Sep 2026". */
export const fullDate = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(numbering(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));

/** The request line and headers as a receiver's log would print them. */
export const requestText = (
  url: string,
  headers: readonly { readonly name: string; readonly value: string }[],
): string => {
  const parsed = URL.parse(url);
  const path = parsed === null ? url : `${parsed.pathname}${parsed.search}`;
  const host = parsed?.host ?? '';
  return [`POST ${path} HTTP/1.1`, `Host: ${host}`, ...headers.map(headerLine)].join('\n');
};

/** `x-helpdock-signature` as a log prints it: `X-Helpdock-Signature`. */
export const headerName = (name: string): string =>
  name.replace(
    /(^|-)([a-z])/g,
    (_match, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`,
  );

const headerLine = ({ name, value }: { readonly name: string; readonly value: string }): string =>
  `${headerName(name)}: ${value}`;

/** The body pretty-printed when it is JSON, as sent otherwise. */
export const prettyBody = (body: string): string => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

/** The curl example of `Admin/Developers-ApiKeys`, against this install's own origin. */
export const curlExample = (origin: string): string =>
  [
    `curl ${origin}/api/v1/tickets \\`,
    '  -H "Authorization: Bearer hd_live_…" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: 8c1e5f0a-order-10442" \\',
    `  -d '{"subject":"Order 10442 arrived damaged","bodyHtml":"<p>The box was crushed.</p>","departmentId":"…"}'`,
  ].join('\n');

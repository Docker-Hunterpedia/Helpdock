import type { AiRefusal } from '@helpdock/schemas';
import { isAiError } from '../../../ai/api.js';
import type { useT } from '../../../app/i18n.js';

type T = ReturnType<typeof useT>;

/** US dollars as the cost log records them; cents unless a call costs less. */
export const usd = (amount: number, digits = 2): string => `$${amount.toFixed(digits)}`;

/** A share of a limit as a whole percentage, for captions. */
export const percentOf = (spent: number, limit: number): number =>
  Math.round((spent / limit) * 100);

/**
 * `embedding.model` becomes `HD_EMBEDDING_MODEL`: the rule `toEnvKey` in
 * `@helpdock/config` applies, restated here because the admin bundle does not
 * load the server's config package. `format.test.ts` pins the two together.
 */
export const envKeyOf = (key: string): string =>
  `HD_${key
    .replaceAll('.', '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()}`;

const KNOWN_KINDS = new Set(['openai', 'anthropic', 'google', 'openrouter', 'openai-compatible']);

/** A provider kind's name, or its pi-ai id for a kind this catalog does not name. */
export const kindLabel = (t: T, kind: string): string =>
  KNOWN_KINDS.has(kind) ? t(`aiSettings:kinds.${kind as 'openai'}`) : kind;

/** The sentence for a refused change, or the one for "that did not work". */
export const failureMessage = (t: T, error: unknown): string =>
  isAiError(error) ? refusalMessage(t, error.reason) : t('aiSettings:actionFailed');

export const refusalMessage = (t: T, reason: AiRefusal): string =>
  t(`aiSettings:refusals.${reason}`);

/** "16:52", in the reader's language. */
export const timeOf = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );

/** "1 Nov", in the reader's language. */
export const dayOf = (date: Date, locale: string): string =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);

/** The first instant of the next UTC day or month: when a spent window opens again. */
export const nextWindow = (period: 'day' | 'month', now: Date): Date =>
  period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

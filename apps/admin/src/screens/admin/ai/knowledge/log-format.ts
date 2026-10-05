import type { KnowledgeLogCode, KnowledgeLogLine } from '@helpdock/schemas';
import type { useT } from '../../../../app/i18n.js';

type T = ReturnType<typeof useT>;

/**
 * A sync log line in the reader's language. The api writes codes and params
 * (M7-03) so the log reads in Arabic too; this is the one place that turns
 * them into sentences. A param the line lacks reads as empty rather than
 * failing the drawer.
 */

const KEY_BY_CODE: Readonly<Record<KnowledgeLogCode, string>> = {
  'sync.started': 'syncStarted',
  'sync.finished': 'syncFinished',
  'sync.failed': 'syncFailed',
  'robots.read': 'robotsRead',
  'robots.unreadable': 'robotsUnreadable',
  'sitemap.read': 'sitemapRead',
  'page.indexed': 'pageIndexed',
  'page.skipped': 'pageSkipped',
  'document.indexed': 'documentIndexed',
  'document.skipped': 'documentSkipped',
  'documents.removed': 'documentsRemoved',
  'injection.stripped': 'injectionStripped',
  'file.rejected': 'fileRejected',
  'embedding.deferred': 'embeddingDeferred',
};

const SKIP_REASONS = new Set(['robots', 'excluded', 'not-included', 'status', 'not-html', 'error']);
const TRIGGERS = new Set(['manual', 'schedule', 'changed', 'upload']);

/** Every placeholder a line may use, so one the api left out reads as empty, not as `{{reason}}`. */
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(
  ['reason', 'detail', 'chunks', 'count', 'found', 'kept', 'rules', 'documents', 'changed'].map(
    (key) => [key, ''],
  ),
);

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** A URL as its path, so a crawl's lines stay short; anything else as it is. */
export const whereOf = (params: Record<string, unknown>): string => {
  const url = text(params.url);
  if (url !== '') {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
  return text(params.title) || text(params.name);
};

const why = (t: T, params: Record<string, unknown>): string => {
  const reason = text(params.reason);
  return SKIP_REASONS.has(reason)
    ? t(`aiSettings:knowledge.logLines.skip.${reason as 'status'}`, { detail: text(params.detail) })
    : text(params.detail) || reason;
};

export function logLineText(t: T, line: Pick<KnowledgeLogLine, 'code' | 'params'>): string {
  const { params } = line;
  if (line.code === 'sync.started') {
    const trigger = text(params.trigger);
    return TRIGGERS.has(trigger)
      ? t(`aiSettings:knowledge.logLines.syncStartedBy.${trigger as 'manual'}`)
      : t('aiSettings:knowledge.logLines.syncStarted');
  }
  if (line.code === 'page.skipped' && params.count !== undefined) {
    return t('aiSettings:knowledge.logLines.pageSkippedCount', {
      count: Number(params.count),
      why: why(t, params),
    });
  }
  const values: Record<string, string> = {
    ...EMPTY_PARAMS,
    where: whereOf(params),
    why: why(t, params),
  };
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'where' && key !== 'why') {
      values[key] = text(value);
    }
  }
  // The params are whatever the line carried, so they cannot be typed per key;
  // every key under `logLines` is a plain string with its own placeholders.
  const translate = t as unknown as (key: string, options: Record<string, string>) => string;
  return translate(`aiSettings:knowledge.logLines.${KEY_BY_CODE[line.code]}`, values);
}

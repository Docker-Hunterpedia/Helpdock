import type { KnowledgeSourceView } from '@helpdock/schemas';
import type { useT } from '../../../../app/i18n.js';

type T = ReturnType<typeof useT>;

const FILE_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'text/markdown': 'MD',
  'text/plain': 'TXT',
};

/** "2.4 MB", "180 KB". */
export const sizeOf = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${String(Math.max(1, Math.round(bytes / 1_000)))} KB`;

/** The caption under a source's name: its kind and what it reads. */
export function detailOf(t: T, source: KnowledgeSourceView): string {
  const { config } = source;
  switch (config.kind) {
    case 'article':
      return t('aiSettings:knowledge.detail.article');
    case 'file':
      return t('aiSettings:knowledge.detail.file', {
        type: FILE_TYPES[config.file.mime] ?? config.file.mime,
        size: sizeOf(config.file.size),
        who: source.createdBy ?? '—',
      });
    case 'crawl':
      return t(
        config.crawl.mode === 'sitemap'
          ? 'aiSettings:knowledge.detail.crawlSitemap'
          : 'aiSettings:knowledge.detail.crawlSeed',
        { max: config.crawl.maxPages },
      );
    case 'notion':
      return config.connected
        ? t('aiSettings:knowledge.detail.notion', {
            pages: config.notion.pageIds.length,
            databases: config.notion.databaseIds.length,
          })
        : `${t('aiSettings:knowledge.kinds.notion')} · ${t('aiSettings:knowledge.detail.notConnected')}`;
    case 'gdrive':
      return config.connected
        ? t('aiSettings:knowledge.detail.gdrive', { folders: config.gdrive.folderIds.length })
        : `${t('aiSettings:knowledge.kinds.gdrive')} · ${t('aiSettings:knowledge.detail.notConnected')}`;
  }
}

export function scheduleOf(t: T, source: KnowledgeSourceView): string {
  if (source.schedule === 'automatic') {
    return source.kind === 'article'
      ? t('aiSettings:knowledge.schedule.automaticArticle')
      : t('aiSettings:knowledge.schedule.automaticFile');
  }
  return t(`aiSettings:knowledge.schedule.${source.schedule}`);
}

/** Notion and Drive sources that hold no credential yet. */
export const needsConnection = (source: KnowledgeSourceView): boolean =>
  (source.config.kind === 'notion' || source.config.kind === 'gdrive') && !source.config.connected;

/** The status word, with the progress when a sync reports it. */
export function stateOf(t: T, source: KnowledgeSourceView): string {
  const { state, progress } = source.status;
  if (state === 'idle' && needsConnection(source)) {
    return t('aiSettings:knowledge.notConnected');
  }
  if (state === 'syncing' && progress !== null) {
    return progress.total === null
      ? t('aiSettings:knowledge.state.syncingCount', { done: progress.done })
      : t('aiSettings:knowledge.state.syncingProgress', {
          done: progress.done,
          total: progress.total,
        });
  }
  return t(`aiSettings:knowledge.state.${state}`);
}

/** "14:02" today, "1 Oct 10:12" before, in the reader's language. */
export function whenOf(iso: string, locale: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return date.toDateString() === now.toDateString()
    ? time.format(date)
    : `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)} ${time.format(date)}`;
}

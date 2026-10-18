import { createI18n } from '@helpdock/i18n';
import { hcImportAssetPath } from '@helpdock/schemas';
import type { SiteContent } from '../dist/help-center/site/site.js';
import { HC_BRAND } from '../src/testing/help-center-site.ts';

export const IMPORTED_FILE_PATH = hcImportAssetPath(
  HC_BRAND,
  '0192c3f0-1a2b-7c3d-8e4f-000000000888',
);
export const IMPORTED_FILE_DOWNLOAD_PATH = `/hc/${HC_BRAND}/_hd/assets/0192c3f0-1a2b-7c3d-8e4f-000000000888`;
export const IMPORTED_FILE_BYTES = Buffer.from('%PDF-1.4\nSynthetic imported guide\n%%EOF\n');

/** The saved article state; database suites prove the loader and download authorization. */
export function withImportedArticle(content: SiteContent): SiteContent {
  return {
    ...content,
    article: async (query) => {
      if (query.slug !== 'imported-source-files') return content.article(query);
      const source = await content.article({ ...query, slug: 'refund-timelines' });
      if (source.state !== 'found') return source;
      const unavailable = createI18n({ lng: query.locale }).t('imports:articleAssetUnavailable');
      return {
        ...source,
        article: {
          ...source.article,
          slug: query.slug,
          title: query.locale === 'ar' ? 'ملفات المصدر المستوردة' : 'Imported source files',
          bodyHtml: `<p><a href="${IMPORTED_FILE_PATH}">original-manual.pdf</a></p><p>${unavailable}: missing-manual.pdf</p>`,
        },
      };
    },
  };
}

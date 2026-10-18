import { hashImportValue } from '@helpdock/importers';
import type { ImportAttachmentRef } from '@helpdock/schemas';
import type { ArticleLoad } from './knowledge-contracts.js';

function attachmentIdentities(refs: ImportAttachmentRef[]) {
  return refs.map(
    ({ url: _url, bundlePath: _path, sourcePage: _page, sourceUrls: _aliases, ...identity }) =>
      identity,
  );
}

/** Rotating a vendor download URL does not change the content saved in Helpdock. */
export function importedArticleContentHash(
  input: ArticleLoad,
  bodyHtml: string,
  sectionId: string,
  assetsPrepared: boolean,
): string {
  const record = assetsPrepared
    ? {
        ...input.record,
        bodyHtml,
        ...(input.record.attachments === undefined
          ? {}
          : { attachments: attachmentIdentities(input.record.attachments) }),
        ...(input.record.published
          ? {
              published: {
                ...input.record.published,
                bodyHtml: input.preparedPublishedBodyHtml ?? input.record.published.bodyHtml,
                ...(input.record.published.attachments === undefined
                  ? {}
                  : { attachments: attachmentIdentities(input.record.published.attachments) }),
              },
            }
          : {}),
      }
    : input.record;
  return hashImportValue({
    record,
    bodyHtml,
    sectionId,
    ...(input.preparedPublishedBodyHtml === undefined
      ? {}
      : { publishedBodyHtml: input.preparedPublishedBodyHtml }),
  });
}

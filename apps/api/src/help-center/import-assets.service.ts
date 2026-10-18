import { articleLinkTargets, SanitizeLimitError } from '@helpdock/channels';
import {
  brands,
  type Db,
  hcArticles,
  hcArticleVersions,
  hcImportAssets,
  hcMedia,
  systemContext,
  withTenant,
} from '@helpdock/db';
import { hcImportAssetParamSchema, hcImportAssetPath, safeFileName } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ObjectStorage } from '../media/storage.js';
import { hcMediaKey } from './media.service.js';
import type { StaffAccess } from './site/staff-access.js';
import { readableBy } from './visibility.js';

export class HelpCenterImportAssetsService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly staff: StaffAccess,
  ) {}

  /** A file UUID is only a locator: live parent/locale membership is checked before any bucket access. */
  async redirect(
    db: Db,
    raw: z.infer<typeof hcImportAssetParamSchema>,
    cookie?: string,
  ): Promise<string> {
    const input = hcImportAssetParamSchema.parse(raw);
    const reader = await this.staff.readerOf(cookie, input.brandId);
    const asset = await withTenant(
      db,
      systemContext(input.brandId, 'help_center.asset_download'),
      async (tx) => {
        const [row] = await tx
          .select({
            media: hcMedia,
            working: hcArticleVersions.bodyHtml,
            published: hcArticleVersions.publishedBodyHtml,
          })
          .from(hcImportAssets)
          .innerJoin(
            hcMedia,
            and(
              eq(hcMedia.id, hcImportAssets.mediaId),
              eq(hcMedia.brandId, hcImportAssets.brandId),
            ),
          )
          .innerJoin(
            hcArticles,
            and(
              eq(hcArticles.id, hcImportAssets.articleId),
              eq(hcArticles.brandId, hcImportAssets.brandId),
            ),
          )
          .innerJoin(
            hcArticleVersions,
            and(
              eq(hcArticleVersions.articleId, hcArticles.id),
              eq(hcArticleVersions.brandId, hcImportAssets.brandId),
              eq(hcArticleVersions.locale, hcImportAssets.locale),
            ),
          )
          .innerJoin(brands, eq(brands.id, hcImportAssets.brandId))
          .where(
            and(
              eq(hcImportAssets.id, input.assetId),
              eq(hcImportAssets.brandId, input.brandId),
              eq(hcImportAssets.usage, 'download'),
              eq(hcMedia.status, 'ready'),
              eq(brands.status, 'active'),
              reader === null ? readableBy('public') : sql`true`,
            ),
          );
        if (!row) return null;
        const target = hcImportAssetPath(input.brandId, input.assetId);
        const bodies = reader === null ? [row.published ?? ''] : [row.working, row.published ?? ''];
        try {
          if (!bodies.some((body) => articleLinkTargets(body).includes(target))) return null;
        } catch (error) {
          if (error instanceof SanitizeLimitError) return null;
          throw error;
        }
        return row.media;
      },
    );
    if (!asset || !['clean', 'skipped'].includes(asset.scanStatus))
      throw new NotFoundException('No such file');
    const image = asset.kind === 'image';
    const key = image ? asset.webpKey : asset.s3Key;
    if (
      !key ||
      key !== hcMediaKey(input.brandId, asset.id, image ? 'webp' : 'original') ||
      (image && asset.mime !== 'image/webp') ||
      (!image && asset.mime.startsWith('image/'))
    )
      throw new NotFoundException('No such file');
    const object = await this.storage.head(key);
    if (!object || (!image && object.size !== asset.size))
      throw new NotFoundException('No such file');
    const name = safeFileName(asset.originalName);
    const fileName = image ? `${name.replace(/\.[^.]+$/, '')}.webp` : name;
    return (
      await this.storage.presignDownload({ key, contentType: asset.mime, fileName, inline: false })
    ).url;
  }
}

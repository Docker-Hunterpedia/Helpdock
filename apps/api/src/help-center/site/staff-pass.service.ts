import { type DbTransaction, users } from '@helpdock/db';
import type { HcStaffPassRequest, HcStaffPassResponse } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { HelpCenterContext } from '../structure.service.js';
import { STAFF_SESSION_PATH } from './paths.js';
import { readSiteConfig } from './site-config.js';
import { readArticleSlug } from './site-reads.js';
import type { HelpCenterSiteSettingsService } from './site-settings.service.js';
import { previewPath, type StaffAccess } from './staff-access.js';

/**
 * `POST /api/brands/:brandId/help-center/staff-pass` (M5-03): the admin's
 * "View help center" and "Preview", and the internal-only wall's sign-in,
 * all end here. The request is an ordinary signed-in one; what it gets back
 * is a one-minute, one-use address on the help center that sets the staff
 * cookie there (`staff-access.ts` explains the two steps).
 */
export class HelpCenterStaffPassService {
  readonly #access: StaffAccess;
  readonly #settings: HelpCenterSiteSettingsService;

  constructor(options: { access: StaffAccess; settings: HelpCenterSiteSettingsService }) {
    this.#access = options.access;
    this.#settings = options.settings;
  }

  async issue(
    { tx, brandId, actorId }: HelpCenterContext,
    familyId: string,
    request: HcStaffPassRequest,
  ): Promise<HcStaffPassResponse> {
    const config = await readSiteConfig(tx, brandId);
    if (config === null) {
      throw new NotFoundException('No such brand');
    }
    const path = await this.#pathFor(tx, request, config.defaultLocale);
    const token = await this.#access.issuePass({
      staffId: actorId,
      familyId,
      name: await nameOf(tx, actorId),
      brandId,
      path,
    });
    const site = this.#settings.siteUrl(config).replace(/\/$/, '');
    return { url: `${site}${STAFF_SESSION_PATH}?pass=${token}` };
  }

  async #pathFor(
    tx: DbTransaction,
    request: HcStaffPassRequest,
    defaultLocale: 'en' | 'ar',
  ): Promise<string> {
    if (request.preview !== undefined) {
      const slug = await readArticleSlug(tx, request.preview.articleId);
      if (slug === null) {
        throw new NotFoundException('No such article');
      }
      return previewPath(request.preview.locale, slug);
    }
    return request.path ?? `/${defaultLocale}`;
  }
}

const nameOf = async (tx: DbTransaction, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.name ?? '';
};

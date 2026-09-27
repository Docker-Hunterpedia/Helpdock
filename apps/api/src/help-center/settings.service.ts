import type { HcSettings, HcSettingsUpdateRequest } from '@helpdock/schemas';
import { writeHcAudit } from './audit.js';
import { enqueueAccessChanged } from './events.js';
import type { HelpCenterRepository } from './help-center.repository.js';
import type { HelpCenterContext } from './structure.service.js';

/**
 * "Who can read it" on Help center › Settings (M5-09): public, or signed-in
 * staff only. The mode is not written onto each article — the read side's
 * filter treats an internal-only help center as having no public article
 * (`visibility.ts`) — so switching back restores every article's own choice.
 * A change is audited and announced (`help_center.access_changed`) so the page
 * cache and the sitemap drop or regain the whole brand at once.
 */
export class HelpCenterSettingsService {
  readonly #repository: HelpCenterRepository;

  constructor(repository: HelpCenterRepository) {
    this.#repository = repository;
  }

  async get({ tx, brandId }: HelpCenterContext): Promise<HcSettings> {
    return { access: await this.#repository.access(tx, brandId) };
  }

  async update(context: HelpCenterContext, request: HcSettingsUpdateRequest): Promise<HcSettings> {
    const { tx, brandId, actorId } = context;
    const before = await this.#repository.access(tx, brandId);
    if (before !== request.access) {
      await this.#repository.setAccess(tx, brandId, request.access, actorId);
      await writeHcAudit(tx, {
        brandId,
        actor: { type: 'staff', id: actorId },
        action: 'hc_settings.updated',
        targetType: 'hc_settings',
        targetId: brandId,
        meta: { before: { access: before }, after: { access: request.access } },
      });
      await enqueueAccessChanged(tx, brandId, request.access);
    }
    return { access: request.access };
  }
}

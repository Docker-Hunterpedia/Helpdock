import { auditLog, type DbTransaction } from '@helpdock/db';
import type {
  RetentionOverview,
  RetentionPreview,
  RetentionSettings,
  RetentionUpdateRequest,
} from '@helpdock/schemas';
import type { RetentionRepository } from './retention.repository.js';
import {
  lastRunFrom,
  retentionCutoffs,
  rowValuesFrom,
  settingsFromRow,
} from './retention-rules.js';

/**
 * The Data retention form's two requests (M1-14): what the brand keeps, what
 * would go if the job ran now, and what went last night; and a save.
 *
 * Admin only, by `brand:manage` on the route: DOMAIN-RULES §11 says "per
 * brand, set by Admin", and §1.2 keeps brand-wide configuration with the Admin.
 */

export interface RetentionContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
}

export class RetentionService {
  readonly #repository: RetentionRepository;
  readonly #now: () => Date;

  constructor(repository: RetentionRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async overview(tx: DbTransaction, brandId: string): Promise<RetentionOverview> {
    const row = await this.#repository.find(tx, brandId);
    const settings = settingsFromRow(row);

    return {
      settings,
      preview: await this.#preview(tx, brandId, settings),
      lastRun: lastRunFrom(row),
    };
  }

  /**
   * Saves the whole form. The audit row carries the before and after, which
   * are day counts and never data: a shortened window is exactly the change an
   * auditor will want to find.
   */
  async update(
    { tx, brandId, actorId }: RetentionContext,
    body: RetentionUpdateRequest,
  ): Promise<RetentionOverview> {
    const before = settingsFromRow(await this.#repository.find(tx, brandId));
    await this.#repository.save(tx, brandId, rowValuesFrom(body), actorId);

    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId,
      action: 'retention.updated',
      targetType: 'brand',
      targetId: brandId,
      meta: { before, after: body },
    });

    return this.overview(tx, brandId);
  }

  /**
   * "Next purge" per row. Counted with the same conditions the job deletes by
   * (`retention.repository.ts`), so the number on the form is the number that
   * goes. The three categories whose tables do not exist yet are null.
   */
  async #preview(
    tx: DbTransaction,
    brandId: string,
    settings: RetentionSettings,
  ): Promise<RetentionPreview> {
    const cutoffs = retentionCutoffs(settings, this.#now());

    return {
      closedTickets:
        cutoffs.closedTickets === null
          ? null
          : await this.#repository.countTickets(tx, brandId, 'closed', cutoffs.closedTickets),
      spamTickets: await this.#repository.countTickets(tx, brandId, 'spam', cutoffs.spamTickets),
      aiCalls: null,
      searchLog: null,
      auditLog: await this.#repository.countAuditLog(tx, brandId, cutoffs.auditLog),
      visitorSessions: null,
    };
  }
}

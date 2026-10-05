import { auditLog, brands, type DbTransaction, INSTALL_SCOPE_BRAND_ID, users } from '@helpdock/db';
import { type BrandDeletion, brandPurgeAfter } from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Logger } from '../logging/logger.js';

/**
 * Brand deletion's two install-admin acts (M8-07, DOMAIN-RULES §11): asking
 * for it, and taking it back within the 30-day grace.
 *
 * Asking sets the brand `deleting` and stamps `deleted_at`. From that moment
 * its widget, help center, web form and channels answer 410
 * (`brand-gone.guard.ts`, the email poller and inbound parse), sessions stop
 * naming it at their next refresh, and nothing else changes: every row, every
 * object and every key is still there, which is what makes a restore whole.
 * The nightly `brand.purge.schedule` purges it once the grace is over
 * (`brand-purge.job.ts`).
 *
 * Both run in the request's install-scope transaction, where `brands` (a
 * global table) is writable and the audit rows land in install scope: the
 * brand's own audit log is about to be purged with it, and the record of who
 * deleted a brand must outlive the brand.
 */

export const BRAND_DELETION_REQUESTED = 'brand.deletion_requested';
export const BRAND_DELETION_CANCELLED = 'brand.deletion_cancelled';

interface DeletionInput {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
  readonly now?: Date;
}

type BrandRow = Pick<typeof brands.$inferSelect, 'id' | 'name' | 'prefix' | 'status' | 'deletedAt'>;

export const deletionOf = (
  row: BrandRow,
  requestedBy: BrandDeletion['requestedBy'] = null,
): BrandDeletion => ({
  brandId: row.id,
  status: row.status,
  requestedAt: row.status === 'active' ? null : (row.deletedAt?.toISOString() ?? null),
  purgeAfter:
    row.status === 'active' || row.deletedAt === null
      ? null
      : brandPurgeAfter(row.deletedAt).toISOString(),
  requestedBy: row.status === 'active' ? null : requestedBy,
});

export class BrandDeletionService {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async status(tx: DbTransaction, brandId: string): Promise<BrandDeletion> {
    const brand = await this.#find(tx, brandId);

    return deletionOf(
      brand,
      brand.status === 'active' ? null : await this.#requestedBy(tx, brandId),
    );
  }

  async request({
    tx,
    brandId,
    actorId,
    confirmPrefix,
    now = new Date(),
  }: DeletionInput & { readonly confirmPrefix: string }): Promise<BrandDeletion> {
    const brand = await this.#find(tx, brandId);
    if (confirmPrefix !== brand.prefix) {
      throw new BadRequestException("Type the brand's prefix to confirm the deletion");
    }
    if (brand.status !== 'active') {
      throw new ConflictException('This brand is already being deleted');
    }

    const [updated] = await tx
      .update(brands)
      .set({ status: 'deleting', deletedAt: now })
      .where(and(eq(brands.id, brandId), eq(brands.status, 'active')))
      .returning();
    /* c8 ignore next 3 -- the row was read as active in this transaction a statement ago. */
    if (updated === undefined) {
      throw new ConflictException('This brand is already being deleted');
    }
    const deletion = deletionOf(updated, await this.#requestedBy(tx, brandId, actorId));
    await this.#audit(tx, actorId, BRAND_DELETION_REQUESTED, brand, {
      purgeAfter: deletion.purgeAfter,
    });
    this.#logger.warn({ brandId, actorId }, 'Brand deletion requested');

    return deletion;
  }

  async cancel({ tx, brandId, actorId, now = new Date() }: DeletionInput): Promise<BrandDeletion> {
    const brand = await this.#find(tx, brandId);
    if (brand.status === 'active') {
      throw new ConflictException('This brand is not being deleted');
    }
    if (
      brand.status === 'deleted' ||
      brand.deletedAt === null ||
      now >= brandPurgeAfter(brand.deletedAt)
    ) {
      throw new ConflictException('The grace period is over; this brand can no longer be restored');
    }

    const [updated] = await tx
      .update(brands)
      .set({ status: 'active', deletedAt: null })
      .where(and(eq(brands.id, brandId), eq(brands.status, 'deleting')))
      .returning();
    /* c8 ignore next 3 -- the row was read as deleting in this transaction a statement ago. */
    if (updated === undefined) {
      throw new ConflictException('This brand is not being deleted');
    }
    await this.#audit(tx, actorId, BRAND_DELETION_CANCELLED, brand, {});
    this.#logger.info({ brandId, actorId }, 'Brand deletion cancelled');

    return deletionOf(updated);
  }

  /**
   * The staff member behind the latest `brand.deletion_requested` row of the
   * brand, or `actorId` when the row is being written now. Install-scope
   * rows, which this install-scope transaction reads.
   */
  async #requestedBy(
    tx: DbTransaction,
    brandId: string,
    actorId?: string,
  ): Promise<BrandDeletion['requestedBy']> {
    const userId =
      actorId ??
      (
        await tx
          .select({ actorId: auditLog.actorId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.brandId, INSTALL_SCOPE_BRAND_ID),
              eq(auditLog.action, BRAND_DELETION_REQUESTED),
              eq(auditLog.targetType, 'brand'),
              eq(auditLog.targetId, brandId),
            ),
          )
          .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
          .limit(1)
      )[0]?.actorId;
    if (userId === undefined) {
      return null;
    }
    const [user] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return { userId, name: user?.name ?? null };
  }

  async #find(tx: DbTransaction, brandId: string): Promise<BrandRow> {
    const [row] = await tx
      .select({
        id: brands.id,
        name: brands.name,
        prefix: brands.prefix,
        status: brands.status,
        deletedAt: brands.deletedAt,
      })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    if (row === undefined) {
      throw new NotFoundException('No such brand');
    }

    return row;
  }

  async #audit(
    tx: DbTransaction,
    actorId: string,
    action: string,
    brand: BrandRow,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'staff',
      actorId,
      action,
      targetType: 'brand',
      targetId: brand.id,
      // The name and prefix, so the row still says which brand it was once the
      // brand's own rows are gone.
      meta: { name: brand.name, prefix: brand.prefix, ...meta },
    });
  }
}

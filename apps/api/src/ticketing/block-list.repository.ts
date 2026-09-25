import {
  type BlockedSender as BlockedSenderRow,
  blockedSenders,
  brandDomains,
  brands,
  type DbTransaction,
  type NewBlockedSender,
  users,
} from '@helpdock/db';
import { type BrandSettings, parseBrandSettings } from '@helpdock/schemas';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { SenderKey } from './block-rules.js';

/**
 * Every statement the block list makes (M1-11).
 *
 * The request's transaction carries `app.brand_ids`, and the policy on
 * `blocked_senders` applies it, as everywhere else in this app. The two reads
 * that name a brand explicitly do so for a reason: `brands` is global and has
 * no policy, and the inbound gate is called from worker transactions that the
 * channel adapters of M2, M4 and M6 open — naming the brand there costs nothing
 * and makes the call site's intent visible.
 */

export interface BlockedSenderWithAuthor {
  readonly sender: BlockedSenderRow;
  /** Null once the person who added it has been deleted. */
  readonly createdByName: string | null;
}

export class BlockListRepository {
  async list(tx: DbTransaction): Promise<BlockedSenderWithAuthor[]> {
    const rows = await tx
      .select({ sender: blockedSenders, createdByName: users.name })
      .from(blockedSenders)
      .leftJoin(users, eq(users.id, blockedSenders.createdBy))
      .orderBy(desc(blockedSenders.createdAt), desc(blockedSenders.id));

    return rows;
  }

  async find(tx: DbTransaction, id: string): Promise<BlockedSenderWithAuthor | undefined> {
    const rows = await tx
      .select({ sender: blockedSenders, createdByName: users.name })
      .from(blockedSenders)
      .leftJoin(users, eq(users.id, blockedSenders.createdBy))
      .where(eq(blockedSenders.id, id))
      .limit(1);

    return rows[0];
  }

  /** Every row among `keys` in this brand. Empty `keys` answers empty without a query. */
  async matching(
    tx: DbTransaction,
    brandId: string,
    keys: readonly SenderKey[],
  ): Promise<BlockedSenderRow[]> {
    if (keys.length === 0) {
      return [];
    }

    return tx
      .select()
      .from(blockedSenders)
      .where(
        and(
          eq(blockedSenders.brandId, brandId),
          or(
            ...keys.map((key) =>
              and(eq(blockedSenders.kind, key.kind), eq(blockedSenders.value, key.value)),
            ),
          ),
        ),
      );
  }

  /**
   * Undefined when the row already exists. `ON CONFLICT DO NOTHING` rather than
   * catching the unique violation, because a refused insert would spoil the
   * transaction the ticket's own status change is still running in.
   */
  async insert(tx: DbTransaction, values: NewBlockedSender): Promise<BlockedSenderRow | undefined> {
    const rows = await tx.insert(blockedSenders).values(values).onConflictDoNothing().returning();

    return rows[0];
  }

  async delete(tx: DbTransaction, id: string): Promise<void> {
    await tx.delete(blockedSenders).where(eq(blockedSenders.id, id));
  }

  /** One more message stopped. An increment in SQL, so two drops at once both count. */
  async recordDrop(tx: DbTransaction, id: string, at: Date): Promise<void> {
    await tx
      .update(blockedSenders)
      .set({ droppedCount: sql`${blockedSenders.droppedCount} + 1`, lastDroppedAt: at })
      .where(eq(blockedSenders.id, id));
  }

  /** The hostnames the brand owns (`brand_domains`), lower-case as stored. */
  async brandDomains(tx: DbTransaction): Promise<string[]> {
    const rows = await tx.select({ domain: brandDomains.domain }).from(brandDomains);

    return rows.map((row) => row.domain);
  }

  async brandSettings(tx: DbTransaction, brandId: string): Promise<BrandSettings | undefined> {
    const rows = await tx
      .select({ settings: brands.settings })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : parseBrandSettings(row.settings);
  }

  async updateBrandSettings(
    tx: DbTransaction,
    brandId: string,
    settings: BrandSettings,
  ): Promise<void> {
    await tx.update(brands).set({ settings }).where(eq(brands.id, brandId));
  }
}

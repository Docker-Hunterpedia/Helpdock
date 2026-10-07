import {
  type DbTransaction,
  users,
  type WebhookDeliveryRow,
  type WebhookRow,
  webhookDeliveries,
  webhooks,
} from '@helpdock/db';
import { and, arrayContains, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';

/**
 * The `webhooks` and `webhook_deliveries` tables (M8-03). Every method takes
 * the caller's transaction, so row-level security decides what it sees: a
 * request's for the Admin and the public API, a brand's system transaction for
 * the worker.
 */

export type NewWebhook = Pick<WebhookRow, 'brandId' | 'url' | 'description' | 'events' | 'secret'> &
  Partial<Pick<WebhookRow, 'createdBy'>>;

export type WebhookChanges = Partial<
  Pick<
    WebhookRow,
    | 'url'
    | 'description'
    | 'events'
    | 'enabled'
    | 'secret'
    | 'secretRotatedAt'
    | 'consecutiveFailures'
    | 'disabledAt'
    | 'disabledReason'
  >
>;

export interface NewDelivery {
  readonly brandId: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly replayOf?: string;
}

/** What one attempt left behind. */
export interface AttemptRecord {
  readonly status: WebhookDeliveryRow['status'];
  readonly attempts: number;
  readonly responseStatus: number | null;
  readonly responseExcerpt: string | null;
  readonly durationMs: number;
  readonly error: string | null;
  readonly at: Date;
}

/** One endpoint for the Developers page: who added it, its recent record, its last delivery. */
export interface WebhookOverviewRow {
  readonly webhook: WebhookRow;
  readonly createdByName: string | null;
  /** Deliveries since `since` that finished, and how many of those succeeded. */
  readonly finished: number;
  readonly succeeded: number;
  readonly lastDelivery: WebhookDeliveryRow | null;
}

export class WebhooksRepository {
  async list(tx: DbTransaction): Promise<WebhookRow[]> {
    return tx.select().from(webhooks).orderBy(desc(webhooks.createdAt));
  }

  /** Three reads rather than one join, so no endpoint's log is scanned more than once. */
  async overview(tx: DbTransaction, since: Date): Promise<WebhookOverviewRow[]> {
    const endpoints = await tx
      .select({ webhook: webhooks, createdByName: users.name })
      .from(webhooks)
      .leftJoin(users, eq(users.id, webhooks.createdBy))
      .orderBy(desc(webhooks.createdAt));
    if (endpoints.length === 0) {
      return [];
    }
    const ids = endpoints.map(({ webhook }) => webhook.id);

    const counts = await tx
      .select({
        webhookId: webhookDeliveries.webhookId,
        finished: sql<number>`count(*) filter (where ${webhookDeliveries.status} in ('succeeded', 'failed'))::int`,
        succeeded: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'succeeded')::int`,
      })
      .from(webhookDeliveries)
      .where(
        and(inArray(webhookDeliveries.webhookId, ids), gte(webhookDeliveries.createdAt, since)),
      )
      .groupBy(webhookDeliveries.webhookId);
    const latest = await tx
      .selectDistinctOn([webhookDeliveries.webhookId])
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.webhookId, ids))
      .orderBy(webhookDeliveries.webhookId, desc(webhookDeliveries.id));

    return endpoints.map(({ webhook, createdByName }) => {
      const count = counts.find((row) => row.webhookId === webhook.id);
      return {
        webhook,
        createdByName,
        finished: count?.finished ?? 0,
        succeeded: count?.succeeded ?? 0,
        lastDelivery: latest.find((row) => row.webhookId === webhook.id) ?? null,
      };
    });
  }

  async find(tx: DbTransaction, webhookId: string): Promise<WebhookRow | undefined> {
    const [row] = await tx.select().from(webhooks).where(eq(webhooks.id, webhookId)).limit(1);
    return row;
  }

  async insert(tx: DbTransaction, values: NewWebhook): Promise<WebhookRow> {
    const [row] = await tx.insert(webhooks).values(values).returning();
    /* c8 ignore next 3 -- an insert refused by a policy throws rather than returning nothing. */
    if (row === undefined) {
      throw new Error('The webhook insert returned no row');
    }
    return row;
  }

  async update(
    tx: DbTransaction,
    webhookId: string,
    changes: WebhookChanges,
  ): Promise<WebhookRow | undefined> {
    const [row] = await tx
      .update(webhooks)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(webhooks.id, webhookId))
      .returning();
    return row;
  }

  async delete(tx: DbTransaction, webhookId: string): Promise<boolean> {
    const rows = await tx
      .delete(webhooks)
      .where(eq(webhooks.id, webhookId))
      .returning({ id: webhooks.id });
    return rows.length > 0;
  }

  /** The switched-on endpoints that asked for this event. */
  async subscribedTo(tx: DbTransaction, event: string): Promise<WebhookRow[]> {
    return tx
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.enabled, true), arrayContains(webhooks.events, [event])));
  }

  /**
   * The delivery row, or nothing when this endpoint already has one for this
   * event: a redelivered outbox event adds no second delivery (DOMAIN-RULES §6).
   */
  async insertDelivery(
    tx: DbTransaction,
    values: NewDelivery,
  ): Promise<WebhookDeliveryRow | undefined> {
    const [row] = await tx
      .insert(webhookDeliveries)
      .values({ ...values, replayOf: values.replayOf ?? null })
      .onConflictDoNothing({
        target: [webhookDeliveries.webhookId, webhookDeliveries.eventId],
        where: sql`${webhookDeliveries.replayOf} is null`,
      })
      .returning();
    return row;
  }

  async delivery(
    tx: DbTransaction,
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryRow | undefined> {
    const [row] = await tx
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, webhookId)))
      .limit(1);
    return row;
  }

  /** A delivery with its endpoint, for the worker. */
  async deliveryTarget(
    tx: DbTransaction,
    deliveryId: string,
  ): Promise<{ delivery: WebhookDeliveryRow; webhook: WebhookRow } | undefined> {
    const [row] = await tx
      .select({ delivery: webhookDeliveries, webhook: webhooks })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    return row;
  }

  /** Newest first, keyed by id: a UUIDv7 orders by creation, so it is the cursor too. */
  async deliveries(
    tx: DbTransaction,
    webhookId: string,
    { before, limit }: { readonly before: string | undefined; readonly limit: number },
  ): Promise<WebhookDeliveryRow[]> {
    return tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.webhookId, webhookId),
          before === undefined ? undefined : lt(webhookDeliveries.id, before),
        ),
      )
      .orderBy(desc(webhookDeliveries.id))
      .limit(limit);
  }

  async recordAttempt(tx: DbTransaction, deliveryId: string, record: AttemptRecord): Promise<void> {
    await tx
      .update(webhookDeliveries)
      .set({
        status: record.status,
        attempts: record.attempts,
        responseStatus: record.responseStatus,
        responseExcerpt: record.responseExcerpt,
        durationMs: record.durationMs,
        error: record.error,
        lastAttemptAt: record.at,
        ...(record.status === 'succeeded' ? { deliveredAt: record.at } : {}),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
  }

  async markSkipped(tx: DbTransaction, deliveryId: string, reason: string): Promise<void> {
    await tx
      .update(webhookDeliveries)
      .set({ status: 'skipped', error: reason })
      .where(eq(webhookDeliveries.id, deliveryId));
  }

  /** Adds one to the run of failed deliveries and answers the new count. */
  async countFailure(tx: DbTransaction, webhookId: string): Promise<number> {
    const [row] = await tx
      .update(webhooks)
      .set({ consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` })
      .where(eq(webhooks.id, webhookId))
      .returning({ failures: webhooks.consecutiveFailures });
    return row?.failures ?? 0;
  }
}

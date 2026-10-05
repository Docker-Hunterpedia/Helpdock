import type { AiCallRecord } from '@helpdock/ai';
import {
  type AiCall,
  type AiSettingsRow,
  aiBudgetAlerts,
  aiCalls,
  aiSettings,
  type DbTransaction,
} from '@helpdock/db';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

/**
 * Every statement M7-01 and M7-08 make against the brand's AI tables. Nothing
 * here opens a transaction: the caller's carries the tenant context, so row-level
 * security has already narrowed every read to the brands it may see, and the
 * brand is still named in each `WHERE` for the reason `retention.repository.ts`
 * gives.
 */

export type AiSettingsValues = Pick<
  AiSettingsRow,
  | 'providerId'
  | 'modelId'
  | 'piiRedaction'
  | 'injectionFilter'
  | 'dailyBudgetUsd'
  | 'monthlyBudgetUsd'
>;

export interface BudgetAlertRow {
  readonly brandId: string;
  readonly period: 'day' | 'month';
  readonly periodStart: string;
  readonly level: 'warning' | 'exceeded';
  readonly spentUsd: number;
  readonly limitUsd: number;
}

export class AiRepository {
  async settings(tx: DbTransaction, brandId: string): Promise<AiSettingsRow | undefined> {
    const [row] = await tx
      .select()
      .from(aiSettings)
      .where(eq(aiSettings.brandId, brandId))
      .limit(1);
    return row;
  }

  async saveSettings(
    tx: DbTransaction,
    brandId: string,
    values: AiSettingsValues,
    actorId: string,
  ): Promise<void> {
    const changes = { ...values, updatedBy: actorId, updatedAt: new Date() };
    await tx
      .insert(aiSettings)
      .values({ brandId, ...changes })
      .onConflictDoUpdate({ target: aiSettings.brandId, set: changes });
  }

  async savePrompt(
    tx: DbTransaction,
    brandId: string,
    systemPrompt: string,
    actorId: string,
  ): Promise<void> {
    const changes = { systemPrompt, updatedBy: actorId, updatedAt: new Date() };
    await tx
      .insert(aiSettings)
      .values({ brandId, ...changes })
      .onConflictDoUpdate({ target: aiSettings.brandId, set: changes });
  }

  /** Brands whose override names this provider. Run in a widened install scope. */
  async brandsUsingProvider(tx: DbTransaction, providerId: string): Promise<number> {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(aiSettings)
      .where(eq(aiSettings.providerId, providerId));
    return row?.total ?? 0;
  }

  /** What the brand spent since each window opened, every call included. */
  async spendSince(
    tx: DbTransaction,
    brandId: string,
    windows: { readonly day: Date; readonly month: Date },
  ): Promise<{ readonly todayUsd: number; readonly monthUsd: number }> {
    const [row] = await tx
      .select({
        today: sql<string>`coalesce(sum(${aiCalls.costUsd}) filter (where ${aiCalls.createdAt} >= ${windows.day.toISOString()}::timestamptz), 0)`,
        month: sql<string>`coalesce(sum(${aiCalls.costUsd}), 0)`,
      })
      .from(aiCalls)
      .where(and(eq(aiCalls.brandId, brandId), gte(aiCalls.createdAt, windows.month)));
    return { todayUsd: Number(row?.today ?? 0), monthUsd: Number(row?.month ?? 0) };
  }

  /** True when this alert is new, which is when it is announced. */
  async insertAlert(tx: DbTransaction, alert: BudgetAlertRow): Promise<boolean> {
    const rows = await tx
      .insert(aiBudgetAlerts)
      .values(alert)
      .onConflictDoNothing()
      .returning({ brandId: aiBudgetAlerts.brandId });
    return rows.length > 0;
  }

  async insertCall(tx: DbTransaction, call: AiCallRecord): Promise<string> {
    const [row] = await tx
      .insert(aiCalls)
      .values({
        brandId: call.brandId,
        ticketId: call.ticketId,
        feature: call.feature,
        provider: call.provider,
        model: call.model,
        status: call.status,
        tokensIn: call.tokensIn,
        tokensOut: call.tokensOut,
        costUsd: call.costUsd,
        latencyMs: Math.round(call.latencyMs),
        redactionCount: call.redactions.length,
        promptHash: call.promptHash,
        prompt: call.prompt === null ? null : { ...call.prompt },
        response: call.response,
        redactions: call.redactions.length === 0 ? null : call.redactions.map((r) => ({ ...r })),
        sources: call.sources === null ? null : [...call.sources],
        error: call.error,
      })
      .returning({ id: aiCalls.id });
    if (row === undefined) {
      throw new Error('The ai_calls insert returned no row');
    }
    return row.id;
  }

  async callsOfTicket(tx: DbTransaction, brandId: string, ticketId: string): Promise<AiCall[]> {
    return tx
      .select()
      .from(aiCalls)
      .where(and(eq(aiCalls.brandId, brandId), eq(aiCalls.ticketId, ticketId)))
      .orderBy(desc(aiCalls.createdAt));
  }
}

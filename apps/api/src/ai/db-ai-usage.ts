import { budgetWindows } from '@helpdock/ai';
import type { Settings } from '@helpdock/config';
import { aiCalls, aiSettings, brands, type Db, type DbTransaction, tickets } from '@helpdock/db';
import type { ReportAi, SystemAiSpend } from '@helpdock/schemas';

type ReportAiDeflection = Extract<ReportAi, { available: true }>['deflection'];

import { and, eq, exists, gte, isNotNull, isNull, lt, ne, or, type SQL, sql } from 'drizzle-orm';
import type { AiUsageRange, AiUsageSource } from '../reports/ai-usage.js';
import { withSystemJob } from '../tenant/system-job.js';

/**
 * The `ai_calls` reader behind the AI seam of Reports and the System page
 * (`reports/ai-usage.ts`, M8-04 and M8-05).
 *
 * - **Cost** is every call of the brand whose UTC instant falls on one of the
 *   range's local days, in the brand's timezone. A department filter keeps
 *   the calls made on that department's tickets; the ticket is joined under
 *   the reader's own department policy, so a Team Leader's report sees the
 *   calls of tickets they may read.
 * - **Deflection** needs the auto-reply of M7-06, which is what decides that
 *   a conversation was answered without a person. Until it ships, nothing is
 *   eligible and the rate is null rather than a zero that would read as "AI
 *   never helped".
 * - **Install spend** is the current UTC month across every brand, one system
 *   transaction per brand. The budget is the sum of the brands' monthly
 *   limits, and null as soon as one brand has none, since an install with an
 *   unlimited brand has no install-wide ceiling.
 */

/** The share of the budget at which the System page warns, as the budget meter does. */
const ALERT_AT_PERCENT = 80;

const USAGE_PRINCIPAL_ID = 'ai-usage';

export class DbAiUsage implements AiUsageSource {
  readonly #settings: Pick<Settings, 'get'>;
  readonly #now: () => Date;

  constructor(settings: Pick<Settings, 'get'>, now: () => Date = () => new Date()) {
    this.#settings = settings;
    this.#now = now;
  }

  async report(tx: DbTransaction, range: AiUsageRange): Promise<ReportAi> {
    const [row] = await tx
      .select({
        calls: sql<number>`count(*)::int`,
        tokensIn: sql<number>`coalesce(sum(${aiCalls.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${aiCalls.tokensOut}), 0)::int`,
        costUsd: sql<string>`coalesce(sum(${aiCalls.costUsd}), 0)`,
      })
      .from(aiCalls)
      .where(inRange(tx, range));

    const deflection = await this.#deflection(tx, range);
    return {
      available: true,
      deflection,
      cost: {
        calls: row?.calls ?? 0,
        tokensIn: row?.tokensIn ?? 0,
        tokensOut: row?.tokensOut ?? 0,
        costUsd: Number(row?.costUsd ?? 0),
      },
    };
  }

  async installSpend(db: Db): Promise<SystemAiSpend> {
    const [providerId, modelId] = await Promise.all([
      this.#settings.get('ai.defaultProvider'),
      this.#settings.get('ai.defaultModel'),
    ]);
    if (providerId === '' || modelId === '') {
      return { configured: false };
    }

    const since = budgetWindows(this.#now()).month;
    const live = await db
      .select({ id: brands.id })
      .from(brands)
      .where(ne(brands.status, 'deleted'));
    let tokens = 0;
    let costUsd = 0;
    let budgetUsd: number | null = live.length === 0 ? null : 0;
    for (const { id: brandId } of live) {
      const brand = await withSystemJob(db, brandId, USAGE_PRINCIPAL_ID, async (tx) => {
        const [spend] = await tx
          .select({
            tokens: sql<number>`coalesce(sum(${aiCalls.tokensIn} + ${aiCalls.tokensOut}), 0)::int`,
            costUsd: sql<string>`coalesce(sum(${aiCalls.costUsd}), 0)`,
          })
          .from(aiCalls)
          .where(and(eq(aiCalls.brandId, brandId), gte(aiCalls.createdAt, since)));
        const [limits] = await tx
          .select({ monthly: aiSettings.monthlyBudgetUsd })
          .from(aiSettings)
          .where(eq(aiSettings.brandId, brandId));
        return {
          tokens: spend?.tokens ?? 0,
          costUsd: Number(spend?.costUsd ?? 0),
          monthly: limits?.monthly ?? null,
        };
      });
      tokens += brand.tokens;
      costUsd += brand.costUsd;
      budgetUsd = budgetUsd === null || brand.monthly === null ? null : budgetUsd + brand.monthly;
    }

    return {
      configured: true,
      tokens,
      costUsd,
      budgetUsd,
      alertAtPercent: budgetUsd === null ? null : ALERT_AT_PERCENT,
    };
  }

  async deflectionRate(tx: DbTransaction, range: AiUsageRange): Promise<number | null> {
    return (await this.#deflection(tx, range)).rate;
  }

  async #deflection(tx: DbTransaction, range: AiUsageRange): Promise<ReportAiDeflection> {
    const quietSince = new Date(this.#now().getTime() - QUIET_MS);
    const localDay = sql`(${tickets.aiEligibleAt} AT TIME ZONE ${range.timezone})::date`;
    const conditions: SQL[] = [
      eq(tickets.brandId, range.brandId),
      isNotNull(tickets.aiEligibleAt),
      sql`${localDay} BETWEEN ${range.from}::date AND ${range.to}::date`,
    ];
    if (range.departmentId !== undefined) {
      conditions.push(eq(tickets.departmentId, range.departmentId));
    }
    const [row] = await tx
      .select({
        eligible: sql<number>`count(*)::int`,
        deflected: sql<number>`count(*) filter (where ${and(
          isNotNull(tickets.aiAnsweredAt),
          isNull(tickets.aiHandedOffAt),
          or(isNotNull(tickets.closedAt), lt(tickets.updatedAt, quietSince)),
        )})::int`,
      })
      .from(tickets)
      .where(and(...conditions));
    const eligible = row?.eligible ?? 0;
    const deflected = row?.deflected ?? 0;
    return { eligible, deflected, rate: eligible === 0 ? null : deflected / eligible };
  }
}

/** "Closed or went inactive for 24 hours" (DOMAIN-RULES §15). */
const QUIET_MS = 24 * 60 * 60 * 1000;

const inRange = (tx: DbTransaction, range: AiUsageRange): SQL => {
  const localDay = sql`(${aiCalls.createdAt} AT TIME ZONE ${range.timezone})::date`;
  const conditions: SQL[] = [
    eq(aiCalls.brandId, range.brandId),
    sql`${localDay} BETWEEN ${range.from}::date AND ${range.to}::date`,
  ];
  if (range.departmentId !== undefined) {
    conditions.push(
      exists(
        tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(
            and(eq(tickets.id, aiCalls.ticketId), eq(tickets.departmentId, range.departmentId)),
          ),
      ),
    );
  }
  return and(...conditions) as SQL;
};

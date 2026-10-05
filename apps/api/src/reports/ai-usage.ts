import type { Db, DbTransaction } from '@helpdock/db';
import type { ReportAi, SystemAiSpend } from '@helpdock/schemas';

/**
 * **The seam for AI numbers** (M8-04, M8-05, M8-07): AI deflection and cost in
 * Reports, LLM spend on the System page, and the AI deflection product metric
 * of DOMAIN-RULES §15.
 *
 * All three are read from `ai_calls` (ARCHITECTURE §5). The app binds
 * `DbAiUsage` (`ai/db-ai-usage.ts`) to {@link AI_USAGE_SOURCE}; {@link NoAiUsage}
 * stays for suites and processes that have no AI data to show, and answers
 * "not available" rather than zeroes.
 *
 * `report` and `deflectionRate` run in the caller's transaction: the
 * report's, narrowed to the brand by row-level security (`ai_calls` is
 * brand-scoped; a department filter goes through the call's ticket, under
 * the reader's department policy), or a system transaction of one brand for
 * the product metrics.
 */

export interface AiUsageRange {
  readonly brandId: string;
  /** Inclusive local days. */
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly departmentId?: string | undefined;
}

export interface AiUsageSource {
  /** Deflection and cost for a report's range and filters. */
  report(tx: DbTransaction, range: AiUsageRange): Promise<ReportAi>;
  /**
   * Install-wide spend for the current budget window, for the System page.
   * Handed the pool rather than a transaction: it reads every brand, and
   * opens one system transaction per brand to do it (DOMAIN-RULES §1.4).
   */
  installSpend(db: Db): Promise<SystemAiSpend>;
  /**
   * AI deflection rate over the range (DOMAIN-RULES §15), or null when the
   * brand has no AI auto-reply data.
   */
  deflectionRate(tx: DbTransaction, range: AiUsageRange): Promise<number | null>;
}

export const AI_USAGE_SOURCE = Symbol('helpdock.ai-usage-source');

/** What every AI number reads as where no `ai_calls` reader is bound. */
export class NoAiUsage implements AiUsageSource {
  async report(): Promise<ReportAi> {
    return { available: false };
  }

  async installSpend(): Promise<SystemAiSpend> {
    return { configured: false };
  }

  async deflectionRate(): Promise<number | null> {
    return null;
  }
}

import {
  BudgetExceededError,
  type BudgetLimits,
  type BudgetSpend,
  budgetStatus,
  budgetWindows,
  exceededWindow,
  type WindowStatus,
} from '@helpdock/ai';
import type { DbTransaction } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import type { AiRepository } from './ai.repository.js';

/**
 * The per-brand budget of M7-08, against `ai_calls`. The spend is the sum of
 * the brand's logged cost since the UTC day and month began — the log *is*
 * the meter, so there is no counter to drift from it.
 *
 * - **Before a call**, {@link BudgetMeter.assertWithinBudget} throws
 *   `BudgetExceededError` once either window is spent: the hard stop.
 * - **After a call is logged**, in the same transaction,
 *   {@link BudgetMeter.announceThresholds} records an alert for each window at
 *   80 % or 100 % and writes an `ai.budget_alert` outbox row the first time
 *   each one is reached in its window — once a day, not once a call.
 */

export const AI_BUDGET_ALERT_EVENT = 'ai.budget_alert';

export interface BudgetReading {
  readonly limits: BudgetLimits;
  readonly spend: BudgetSpend;
  readonly windows: readonly WindowStatus[];
}

export class BudgetMeter {
  readonly #repository: AiRepository;
  readonly #now: () => Date;

  constructor(repository: AiRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async read(tx: DbTransaction, brandId: string): Promise<BudgetReading> {
    const now = this.#now();
    const row = await this.#repository.settings(tx, brandId);
    const limits = {
      dailyUsd: row?.dailyBudgetUsd ?? null,
      monthlyUsd: row?.monthlyBudgetUsd ?? null,
    };
    const spend = await this.#repository.spendSince(tx, brandId, budgetWindows(now));
    return { limits, spend, windows: budgetStatus(limits, spend, now) };
  }

  async assertWithinBudget(tx: DbTransaction, brandId: string): Promise<void> {
    const spent = exceededWindow((await this.read(tx, brandId)).windows);
    if (spent !== undefined) {
      throw new BudgetExceededError(brandId, spent);
    }
  }

  async announceThresholds(tx: DbTransaction, brandId: string): Promise<void> {
    const { windows } = await this.read(tx, brandId);
    for (const window of windows) {
      if (window.level === 'ok') {
        continue;
      }
      const alert = {
        brandId,
        period: window.period,
        periodStart: window.periodStart,
        level: window.level,
        spentUsd: window.spentUsd,
        limitUsd: window.limitUsd,
      };
      if (await this.#repository.insertAlert(tx, alert)) {
        await enqueueOutbox(tx, {
          brandId,
          event: AI_BUDGET_ALERT_EVENT,
          payload: {
            period: alert.period,
            periodStart: alert.periodStart,
            level: alert.level,
            spentUsd: alert.spentUsd,
            limitUsd: alert.limitUsd,
          },
        });
      }
    }
  }
}

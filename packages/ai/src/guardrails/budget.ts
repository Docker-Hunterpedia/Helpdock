/**
 * The per-brand budget of M7-08 (REQUIREMENTS §4.7, ARCHITECTURE §10): a daily
 * and a monthly limit in US dollars, an alert at 80 % of either and a hard
 * stop at 100 %. This file is the arithmetic; the api reads the spend from
 * `ai_calls` and records the alerts.
 *
 * Windows are UTC calendar days and months, so "today" means the same thing
 * on every replica and in every report.
 */

export type BudgetPeriod = 'day' | 'month';
export type BudgetLevel = 'ok' | 'warning' | 'exceeded';

/** The share of a limit at which the alert fires. */
export const BUDGET_WARNING_RATIO = 0.8;

export interface BudgetLimits {
  /** US dollars; null for no limit. */
  readonly dailyUsd: number | null;
  readonly monthlyUsd: number | null;
}

export interface BudgetSpend {
  readonly todayUsd: number;
  readonly monthUsd: number;
}

export interface WindowStatus {
  readonly period: BudgetPeriod;
  readonly level: BudgetLevel;
  readonly spentUsd: number;
  readonly limitUsd: number;
  /** `YYYY-MM-DD`, the first day of the window. */
  readonly periodStart: string;
}

/** Thrown by `complete()` instead of calling a model once a brand's budget is spent. */
export class BudgetExceededError extends Error {
  readonly brandId: string;
  readonly period: BudgetPeriod;
  readonly spentUsd: number;
  readonly limitUsd: number;

  constructor(brandId: string, window: Pick<WindowStatus, 'period' | 'spentUsd' | 'limitUsd'>) {
    super(
      `The ${window.period === 'day' ? 'daily' : 'monthly'} AI budget of brand ${brandId} is spent (${window.spentUsd.toFixed(4)} of ${window.limitUsd.toFixed(4)} USD)`,
    );
    this.name = 'BudgetExceededError';
    this.brandId = brandId;
    this.period = window.period;
    this.spentUsd = window.spentUsd;
    this.limitUsd = window.limitUsd;
  }
}

export const levelOf = (spentUsd: number, limitUsd: number | null): BudgetLevel => {
  if (limitUsd === null) {
    return 'ok';
  }
  if (spentUsd >= limitUsd) {
    return 'exceeded';
  }
  return spentUsd >= limitUsd * BUDGET_WARNING_RATIO ? 'warning' : 'ok';
};

/** Midnight UTC of the day, and of the first of the month, `now` falls in. */
export const budgetWindows = (now: Date): { readonly day: Date; readonly month: Date } => ({
  day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
  month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
});

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Every window that has a limit, with where its spend stands. */
export const budgetStatus = (
  limits: BudgetLimits,
  spend: BudgetSpend,
  now: Date,
): readonly WindowStatus[] => {
  const windows = budgetWindows(now);
  const statuses: WindowStatus[] = [];
  if (limits.dailyUsd !== null) {
    statuses.push({
      period: 'day',
      level: levelOf(spend.todayUsd, limits.dailyUsd),
      spentUsd: spend.todayUsd,
      limitUsd: limits.dailyUsd,
      periodStart: isoDate(windows.day),
    });
  }
  if (limits.monthlyUsd !== null) {
    statuses.push({
      period: 'month',
      level: levelOf(spend.monthUsd, limits.monthlyUsd),
      spentUsd: spend.monthUsd,
      limitUsd: limits.monthlyUsd,
      periodStart: isoDate(windows.month),
    });
  }
  return statuses;
};

/** The first window that is spent, or undefined while every one has room. */
export const exceededWindow = (statuses: readonly WindowStatus[]): WindowStatus | undefined =>
  statuses.find((status) => status.level === 'exceeded');

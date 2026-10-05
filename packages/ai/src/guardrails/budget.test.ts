import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  budgetStatus,
  budgetWindows,
  exceededWindow,
  levelOf,
} from './budget.js';

const now = new Date('2026-10-05T17:30:00Z');

describe('the budget level', () => {
  it('is ok below 80 %, a warning from 80 %, exceeded from 100 %', () => {
    expect(levelOf(7.99, 10)).toBe('ok');
    expect(levelOf(8, 10)).toBe('warning');
    expect(levelOf(10, 10)).toBe('exceeded');
    expect(levelOf(12, 10)).toBe('exceeded');
  });

  it('is always ok without a limit', () => {
    expect(levelOf(1_000, null)).toBe('ok');
  });
});

describe('the budget windows', () => {
  it('are the UTC day and month', () => {
    expect(budgetWindows(now)).toEqual({
      day: new Date('2026-10-05T00:00:00Z'),
      month: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('report only the windows that have a limit', () => {
    const statuses = budgetStatus(
      { dailyUsd: null, monthlyUsd: 100 },
      { todayUsd: 5, monthUsd: 85 },
      now,
    );

    expect(statuses).toEqual([
      { period: 'month', level: 'warning', spentUsd: 85, limitUsd: 100, periodStart: '2026-10-01' },
    ]);
    expect(exceededWindow(statuses)).toBeUndefined();
  });

  it('find the spent window', () => {
    const statuses = budgetStatus(
      { dailyUsd: 2, monthlyUsd: 100 },
      { todayUsd: 2.5, monthUsd: 20 },
      now,
    );

    expect(exceededWindow(statuses)).toMatchObject({ period: 'day', periodStart: '2026-10-05' });
  });
});

describe('BudgetExceededError', () => {
  it('names the window and the amounts', () => {
    const error = new BudgetExceededError('brand-1', {
      period: 'month',
      spentUsd: 101,
      limitUsd: 100,
    });

    expect(error.message).toMatch(/monthly AI budget/);
    expect(error).toMatchObject({ period: 'month', spentUsd: 101, limitUsd: 100 });
  });
});

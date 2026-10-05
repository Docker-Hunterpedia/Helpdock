import { BudgetExceededError } from '@helpdock/ai';
import type { AiSettingsRow, DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import type { AiRepository, BudgetAlertRow } from './ai.repository.js';
import { AI_BUDGET_ALERT_EVENT, BudgetMeter } from './budget-meter.js';

const BRAND = '0192f4d2-0000-7000-8000-000000000001';
const NOW = new Date('2026-10-05T12:00:00Z');

/** A repository over one brand's limits and spend, and a transaction that records outbox rows. */
const harness = (limits: Partial<AiSettingsRow>, spend: { todayUsd: number; monthUsd: number }) => {
  const alerts = new Set<string>();
  const outbox: Record<string, unknown>[] = [];
  const repository = {
    settings: async () => ({ dailyBudgetUsd: null, monthlyBudgetUsd: null, ...limits }),
    spendSince: async () => spend,
    insertAlert: async (_tx: DbTransaction, alert: BudgetAlertRow) => {
      const key = `${alert.period}:${alert.periodStart}:${alert.level}`;
      const fresh = !alerts.has(key);
      alerts.add(key);
      return fresh;
    },
  } as unknown as AiRepository;
  const tx = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        outbox.push(row);
        return { returning: async () => [{ id: '0192f4d2-0000-7000-8000-0000000000ff' }] };
      },
    }),
  } as unknown as DbTransaction;

  return { meter: new BudgetMeter(repository, () => NOW), tx, outbox };
};

describe('BudgetMeter.assertWithinBudget', () => {
  it('lets a brand with room through, and one without a budget at all', async () => {
    const within = harness({ dailyBudgetUsd: 10 }, { todayUsd: 9.99, monthUsd: 9.99 });
    const unlimited = harness({}, { todayUsd: 1_000, monthUsd: 1_000 });

    await expect(within.meter.assertWithinBudget(within.tx, BRAND)).resolves.toBeUndefined();
    await expect(unlimited.meter.assertWithinBudget(unlimited.tx, BRAND)).resolves.toBeUndefined();
  });

  it('stops a brand whose monthly budget is spent, even with room left today', async () => {
    const { meter, tx } = harness(
      { dailyBudgetUsd: 10, monthlyBudgetUsd: 100 },
      { todayUsd: 1, monthUsd: 100 },
    );

    await expect(meter.assertWithinBudget(tx, BRAND)).rejects.toMatchObject({
      constructor: BudgetExceededError,
      period: 'month',
    });
  });
});

describe('BudgetMeter.announceThresholds', () => {
  it('writes one ai.budget_alert per window and level, however many calls cross it', async () => {
    const { meter, tx, outbox } = harness({ dailyBudgetUsd: 10 }, { todayUsd: 8, monthUsd: 8 });

    await meter.announceThresholds(tx, BRAND);
    await meter.announceThresholds(tx, BRAND);

    expect(outbox).toEqual([
      expect.objectContaining({
        brandId: BRAND,
        event: AI_BUDGET_ALERT_EVENT,
        payload: {
          period: 'day',
          periodStart: '2026-10-05',
          level: 'warning',
          spentUsd: 8,
          limitUsd: 10,
        },
      }),
    ]);
  });

  it('says nothing below 80 %', async () => {
    const { meter, tx, outbox } = harness({ dailyBudgetUsd: 10 }, { todayUsd: 7, monthUsd: 7 });

    await meter.announceThresholds(tx, BRAND);

    expect(outbox).toEqual([]);
  });
});

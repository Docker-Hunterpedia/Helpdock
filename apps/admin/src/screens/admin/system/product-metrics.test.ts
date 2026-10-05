import { describe, expect, it } from 'vitest';
import { daysLeft, isLastDays } from './deletion-countdown.js';
import { productMetrics } from './fixtures.js';
import { activationDay, installDeflection, installSelfService } from './product-metrics.js';

const brand = (overrides: {
  widgetViews: number;
  followedByTicket: number;
  articleViews?: number;
  aiDeflectionRate?: number | null;
}) => ({
  brandId: '0192c3f0-1a2b-7c3d-8e4f-0000000000b1',
  name: 'Brand',
  selfService: {
    articleViews: overrides.articleViews ?? overrides.widgetViews,
    widgetViews: overrides.widgetViews,
    followedByTicket: overrides.followedByTicket,
    rate: null,
  },
  aiDeflectionRate: overrides.aiDeflectionRate ?? null,
});

describe('activationDay', () => {
  it('counts whole days from the wizard to the first channel ticket', () => {
    expect(activationDay(productMetrics().activation)).toBe(2);
  });

  it('has no day until both have happened', () => {
    expect(
      activationDay({
        wizardCompletedAt: '2026-09-01T09:00:00.000Z',
        firstChannelTicketAt: null,
        activated: false,
      }),
    ).toBeNull();
  });
});

describe('installSelfService', () => {
  it('weighs each brand by its views rather than averaging the rates', () => {
    expect(
      installSelfService([
        brand({ widgetViews: 900, followedByTicket: 90 }),
        brand({ widgetViews: 100, followedByTicket: 50 }),
      ]),
    ).toEqual({ articleViews: 1000, rate: 0.86 });
  });

  it('has no rate without widget views', () => {
    expect(
      installSelfService([brand({ widgetViews: 0, followedByTicket: 0, articleViews: 4 })]),
    ).toEqual({ articleViews: 4, rate: null });
  });
});

describe('installDeflection', () => {
  it('is not available until a brand records auto-replies', () => {
    expect(installDeflection([brand({ widgetViews: 1, followedByTicket: 0 })])).toEqual({
      rate: null,
      brands: 0,
    });
  });

  it('averages the brands that record them', () => {
    const result = installDeflection([
      brand({ widgetViews: 1, followedByTicket: 0, aiDeflectionRate: 0.3 }),
      brand({ widgetViews: 1, followedByTicket: 0, aiDeflectionRate: 0.5 }),
      brand({ widgetViews: 1, followedByTicket: 0 }),
    ]);

    expect(result.brands).toBe(2);
    expect(result.rate).toBeCloseTo(0.4);
  });
});

describe('the deletion countdown', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z');

  it('rounds a part day up, and never goes below zero', () => {
    expect(daysLeft('2026-10-31T12:00:00.000Z', now)).toBe(26);
    expect(daysLeft('2026-10-05T13:00:00.000Z', now)).toBe(1);
    expect(daysLeft('2026-10-01T00:00:00.000Z', now)).toBe(0);
  });

  it('warns in the last three days', () => {
    expect(isLastDays(3)).toBe(true);
    expect(isLastDays(4)).toBe(false);
  });
});

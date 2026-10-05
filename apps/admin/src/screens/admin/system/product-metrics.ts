import type { ProductMetrics } from '@helpdock/schemas';

/**
 * The three install-wide figures of the Product metrics row (M8-07,
 * DOMAIN-RULES §15), reduced from the per-brand answer.
 */

const DAY_MS = 86_400_000;

/**
 * The day the first channel ticket came, counting the wizard's day as day 0;
 * null until there has been one.
 */
export const activationDay = (activation: ProductMetrics['activation']): number | null => {
  if (activation.wizardCompletedAt === null || activation.firstChannelTicketAt === null) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(
      (Date.parse(activation.firstChannelTicketAt) - Date.parse(activation.wizardCompletedAt)) /
        DAY_MS,
    ),
  );
};

export interface SelfService {
  readonly articleViews: number;
  /** Widget views not followed by a ticket, over widget views; null with none. */
  readonly rate: number | null;
}

/** Summed over every brand, so a busy brand weighs what it should. */
export const installSelfService = (brands: ProductMetrics['brands']): SelfService => {
  const totals = brands.reduce(
    (sum, brand) => ({
      articleViews: sum.articleViews + brand.selfService.articleViews,
      widgetViews: sum.widgetViews + brand.selfService.widgetViews,
      followed: sum.followed + brand.selfService.followedByTicket,
    }),
    { articleViews: 0, widgetViews: 0, followed: 0 },
  );

  return {
    articleViews: totals.articleViews,
    rate:
      totals.widgetViews === 0 ? null : (totals.widgetViews - totals.followed) / totals.widgetViews,
  };
};

export interface Deflection {
  /** The mean over the brands that record auto-replies; null when none does yet (M7). */
  readonly rate: number | null;
  readonly brands: number;
}

export const installDeflection = (brands: ProductMetrics['brands']): Deflection => {
  const rates = brands.flatMap((brand) =>
    brand.aiDeflectionRate === null ? [] : [brand.aiDeflectionRate],
  );

  return {
    rate: rates.length === 0 ? null : rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
    brands: rates.length,
  };
};

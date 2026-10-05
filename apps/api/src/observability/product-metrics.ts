import { brands, type Db, reportHelpCenterDaily } from '@helpdock/db';
import type { ProductMetrics } from '@helpdock/schemas';
import { and, asc, eq, gte, ne, sql, sum } from 'drizzle-orm';
import type { AiUsageSource } from '../reports/ai-usage.js';
import { addDays, localDay } from '../reports/rollup-window.js';
import { withSystemJob } from '../tenant/system-job.js';

/**
 * The product metrics of DOMAIN-RULES §15 on the System page (M8-07).
 *
 * - **Activation**: an install that received its first ticket from a channel
 *   that is not manual — email, widget, Telegram, form, API — within 7 days
 *   of the wizard. The wizard's end is when the first brand was created; it
 *   makes that brand.
 * - **Help center self-service**: article views not followed by a ticket from
 *   the same visitor within an hour, over article views. Only a view in the
 *   widget names a visitor a ticket can also name, so the rate is over those;
 *   the count of every view is reported beside it (`report_help_center_daily`).
 * - **AI deflection**: from the AI seam (`reports/ai-usage.ts`), null until M7.
 *
 * Each brand is read in a system transaction of its own (DOMAIN-RULES §1.4);
 * the install-admin route that asks has already been audited.
 */

export const PRODUCT_METRICS_WINDOW_DAYS = 30;
const ACTIVATION_DAYS = 7;
const PRINCIPAL = 'system.product-metrics';

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

export class ProductMetricsService {
  readonly #db: Db;
  readonly #ai: AiUsageSource;

  constructor(db: Db, ai: AiUsageSource) {
    this.#db = db;
    this.#ai = ai;
  }

  async read(now: Date = new Date()): Promise<ProductMetrics> {
    const all = await this.#db
      .select({
        id: brands.id,
        name: brands.name,
        status: brands.status,
        timezone: brands.timezone,
        createdAt: brands.createdAt,
      })
      .from(brands)
      .where(ne(brands.status, 'deleted'))
      .orderBy(asc(brands.createdAt));

    const wizard = all[0]?.createdAt ?? null;
    const firstTickets = await Promise.all(all.map((brand) => this.#firstChannelTicket(brand.id)));
    const first = firstTickets
      .filter((at): at is Date => at !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    const active = all.filter((brand) => brand.status === 'active');

    return {
      observedAt: now.toISOString(),
      activation: {
        wizardCompletedAt: wizard?.toISOString() ?? null,
        firstChannelTicketAt: first?.toISOString() ?? null,
        activated:
          wizard !== null &&
          first !== undefined &&
          first.getTime() - wizard.getTime() <= ACTIVATION_DAYS * 86_400_000,
      },
      windowDays: PRODUCT_METRICS_WINDOW_DAYS,
      brands: await Promise.all(active.map((brand) => this.#brandMetrics(brand, now))),
    };
  }

  async #firstChannelTicket(brandId: string): Promise<Date | null> {
    const [row] = await withSystemJob(this.#db, brandId, PRINCIPAL, (tx) =>
      tx.execute<{ at: Date | string | null }>(
        sql`SELECT min(created_at) AS at FROM tickets WHERE brand_id = ${brandId} AND channel <> 'manual'`,
      ),
    );

    return row?.at == null ? null : new Date(row.at);
  }

  async #brandMetrics(
    brand: { id: string; name: string; timezone: string },
    now: Date,
  ): Promise<ProductMetrics['brands'][number]> {
    const to = localDay(now, brand.timezone);
    const from = addDays(to, -(PRODUCT_METRICS_WINDOW_DAYS - 1));

    return withSystemJob(this.#db, brand.id, PRINCIPAL, async (tx) => {
      const [views] = await tx
        .select({
          articleViews: sum(reportHelpCenterDaily.articleViews),
          widgetViews: sum(reportHelpCenterDaily.widgetViews),
          followed: sum(reportHelpCenterDaily.widgetViewsFollowedByTicket),
        })
        .from(reportHelpCenterDaily)
        .where(
          and(eq(reportHelpCenterDaily.brandId, brand.id), gte(reportHelpCenterDaily.day, from)),
        );
      const widgetViews = Number(views?.widgetViews ?? 0);
      const followed = Number(views?.followed ?? 0);

      return {
        brandId: brand.id,
        name: brand.name,
        selfService: {
          articleViews: Number(views?.articleViews ?? 0),
          widgetViews,
          followedByTicket: followed,
          rate: rate(widgetViews - followed, widgetViews),
        },
        aiDeflectionRate: await this.#ai.deflectionRate(tx, {
          brandId: brand.id,
          from,
          to,
          timezone: brand.timezone,
        }),
      };
    });
  }
}

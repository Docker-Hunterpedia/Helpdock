import {
  brandDomains,
  businessHours,
  cannedResponses,
  type DbTransaction,
  departments,
  hcArticleVersions,
  mailboxes,
  metaAccounts,
  setupChecklistDismissals,
  slaPolicies,
  telegramBots,
  tickets,
  userBrandRoles,
  widgetSettings,
} from '@helpdock/db';
import type { SetupChecklistStepId } from '@helpdock/schemas';
import { and, eq, gte, sql } from 'drizzle-orm';

/** The steps the brand's own rows answer. The AI provider is a setting, so the service reads it. */
export type RowFacts = Readonly<Record<Exclude<SetupChecklistStepId, 'aiProvider'>, boolean>>;

/**
 * Every statement the setup checklist makes. Each step is one `EXISTS`, asked of
 * the brand's rows under the request's row-level security, and nothing is
 * stored: a step ticks the moment the row it asks for exists and un-ticks when
 * the row goes. The brand is named in every predicate as well as by the policy,
 * so a transaction that sees several brands (an install admin's) still answers
 * for the one asked about.
 */
export class SetupChecklistRepository {
  async rowFacts(tx: DbTransaction, brandId: string): Promise<RowFacts> {
    const [row] = await tx.execute<{
      channel: boolean;
      teammate: boolean;
      business_hours: boolean;
      sla_policy: boolean;
      assignment: boolean;
      reply: boolean;
      article: boolean;
      first_ticket: boolean;
    }>(sql`
      SELECT
        (
          EXISTS (SELECT 1 FROM ${mailboxes} WHERE ${mailboxes.brandId} = ${brandId})
          OR EXISTS (SELECT 1 FROM ${telegramBots} WHERE ${telegramBots.brandId} = ${brandId})
          OR EXISTS (SELECT 1 FROM ${metaAccounts} WHERE ${metaAccounts.brandId} = ${brandId})
          OR EXISTS (
            SELECT 1 FROM ${widgetSettings}
            WHERE ${widgetSettings.brandId} = ${brandId}
              AND cardinality(${widgetSettings.allowedOrigins}) > 0
          )
          OR EXISTS (
            SELECT 1 FROM ${brandDomains}
            WHERE ${brandDomains.brandId} = ${brandId} AND ${brandDomains.kind} = 'widget_origin'
          )
        ) AS channel,
        (
          SELECT count(*) FROM ${userBrandRoles} WHERE ${userBrandRoles.brandId} = ${brandId}
        ) > 1 AS teammate,
        EXISTS (
          SELECT 1 FROM ${businessHours} WHERE ${businessHours.brandId} = ${brandId}
        ) AS business_hours,
        EXISTS (
          SELECT 1 FROM ${slaPolicies} WHERE ${slaPolicies.brandId} = ${brandId}
        ) AS sla_policy,
        EXISTS (
          SELECT 1 FROM ${departments}
          WHERE ${departments.brandId} = ${brandId} AND ${departments.assignmentMode} <> 'manual'
        ) AS assignment,
        EXISTS (
          SELECT 1 FROM ${cannedResponses} WHERE ${cannedResponses.brandId} = ${brandId}
        ) AS reply,
        EXISTS (
          SELECT 1 FROM ${hcArticleVersions}
          WHERE ${hcArticleVersions.brandId} = ${brandId}
            AND ${hcArticleVersions.status} = 'published'
            AND ${hcArticleVersions.visibility} = 'public'
        ) AS article,
        EXISTS (
          SELECT 1 FROM ${tickets}
          WHERE ${tickets.brandId} = ${brandId}
            AND ${tickets.channel} <> 'manual'
            AND ${tickets.importedAt} IS NULL
        ) AS first_ticket
    `);

    if (row === undefined) {
      throw new Error('The setup checklist query returned no row');
    }

    return {
      channel: row.channel,
      teammate: row.teammate,
      businessHours: row.business_hours,
      slaPolicy: row.sla_policy,
      assignment: row.assignment,
      reply: row.reply,
      article: row.article,
      firstTicket: row.first_ticket,
    };
  }

  /**
   * Whether this person hid the checklist for this brand and has held their role
   * since. A role removed and granted again is a new row dated later than the
   * dismissal, so the checklist comes back without anything deleting the old one.
   */
  async isDismissed(tx: DbTransaction, brandId: string, userId: string): Promise<boolean> {
    const rows = await tx
      .select({ userId: setupChecklistDismissals.userId })
      .from(setupChecklistDismissals)
      .innerJoin(
        userBrandRoles,
        and(
          eq(userBrandRoles.brandId, setupChecklistDismissals.brandId),
          eq(userBrandRoles.userId, setupChecklistDismissals.userId),
        ),
      )
      .where(
        and(
          eq(setupChecklistDismissals.brandId, brandId),
          eq(setupChecklistDismissals.userId, userId),
          gte(setupChecklistDismissals.dismissedAt, userBrandRoles.createdAt),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  async dismiss(tx: DbTransaction, brandId: string, userId: string): Promise<void> {
    await tx
      .insert(setupChecklistDismissals)
      .values({ brandId, userId })
      .onConflictDoUpdate({
        target: [setupChecklistDismissals.brandId, setupChecklistDismissals.userId],
        set: { dismissedAt: sql`now()` },
      });
  }
}

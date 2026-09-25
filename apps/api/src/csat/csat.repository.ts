import {
  brands,
  type CsatResponse,
  csatResponses,
  type DbTransaction,
  ticketStatuses,
  tickets,
} from '@helpdock/db';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';

/**
 * Every query M1-12's survey makes, each one in the caller's transaction so the
 * policies decide what it can reach (DOMAIN-RULES §1.3). Nothing filters by
 * brand or department here.
 */

/** What the survey job needs to decide that a close still deserves one. */
export interface ClosedTicketFacts {
  readonly departmentId: string;
  readonly closedAt: Date | null;
  readonly mergedIntoId: string | null;
  readonly deletedAt: Date | null;
  /** The status is the brand's Spam (M1-11's `is_spam`); a merge is `mergedIntoId`. */
  readonly isSpam: boolean;
}

/** What the public page may print about the ticket, and nothing more. */
export interface SurveyWithTicket {
  readonly survey: CsatResponse;
  readonly reference: string;
  readonly subject: string;
}

export class CsatRepository {
  async closedTicketFacts(
    tx: DbTransaction,
    ticketId: string,
  ): Promise<ClosedTicketFacts | undefined> {
    const [row] = await tx
      .select({
        departmentId: tickets.departmentId,
        closedAt: tickets.closedAt,
        mergedIntoId: tickets.mergedIntoId,
        deletedAt: tickets.deletedAt,
        isSpam: ticketStatuses.isSpam,
      })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(eq(tickets.id, ticketId))
      .limit(1);

    return row;
  }

  /** Inserts the survey unless this close already has one; a redelivered job is a no-op. */
  async insertSurvey(
    tx: DbTransaction,
    values: {
      readonly id: string;
      readonly brandId: string;
      readonly ticketId: string;
      readonly departmentId: string;
      readonly closedAt: Date;
      readonly tokenHash: string;
      readonly expiresAt: Date;
    },
  ): Promise<boolean> {
    const inserted = await tx
      .insert(csatResponses)
      .values(values)
      .onConflictDoNothing({ target: [csatResponses.ticketId, csatResponses.closedAt] })
      .returning({ id: csatResponses.id });

    return inserted.length > 0;
  }

  /** The survey for the ticket's most recent close. */
  async latestForTicket(tx: DbTransaction, ticketId: string): Promise<CsatResponse | undefined> {
    const [row] = await tx
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.ticketId, ticketId))
      .orderBy(desc(csatResponses.closedAt))
      .limit(1);

    return row;
  }

  async findWithTicket(tx: DbTransaction, surveyId: string): Promise<SurveyWithTicket | undefined> {
    const [row] = await tx
      .select({
        survey: csatResponses,
        prefix: tickets.prefix,
        number: tickets.number,
        subject: tickets.subject,
      })
      .from(csatResponses)
      .innerJoin(tickets, eq(tickets.id, csatResponses.ticketId))
      // A ticket an Admin deleted is hidden from every view (DOMAIN-RULES §2.2),
      // and its survey's link with it.
      .where(and(eq(csatResponses.id, surveyId), isNull(tickets.deletedAt)))
      .limit(1);

    return row === undefined
      ? undefined
      : {
          survey: row.survey,
          reference: `${row.prefix}-${String(row.number)}`,
          subject: row.subject,
        };
  }

  /**
   * Records the answer if, and only if, the survey is still open. The two
   * conditions are in the `WHERE`, so two submissions racing cannot both win:
   * the second finds `rated_at` set and updates nothing.
   */
  async rate(
    tx: DbTransaction,
    surveyId: string,
    answer: { readonly rating: number; readonly comment: string | null; readonly at: Date },
  ): Promise<boolean> {
    const updated = await tx
      .update(csatResponses)
      .set({ rating: answer.rating, comment: answer.comment, ratedAt: answer.at })
      .where(
        and(
          eq(csatResponses.id, surveyId),
          isNull(csatResponses.ratedAt),
          gt(csatResponses.expiresAt, answer.at),
        ),
      )
      .returning({ id: csatResponses.id });

    return updated.length > 0;
  }

  /** `brands` is global, so this read needs no more than the brand id the token named. */
  async brand(
    tx: DbTransaction,
    brandId: string,
  ): Promise<{ name: string; defaultLocale: 'en' | 'ar' } | undefined> {
    const [row] = await tx
      .select({ name: brands.name, defaultLocale: brands.defaultLocale })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return row;
  }
}

import {
  brands,
  type CsatResponse,
  contactIdentities,
  csatResponses,
  type DbTransaction,
  type Ticket,
  ticketActivity,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
} from '@helpdock/db';
import type { CsatAnswerChannel } from '@helpdock/schemas';
import { and, desc, eq, gt, isNull, lte, or, type SQL, sql } from 'drizzle-orm';

/**
 * Every query M1-12's survey makes, each one in the caller's transaction so the
 * policies decide what it can reach (DOMAIN-RULES §1.3). Nothing filters by
 * brand or department here.
 */

/** What the survey job needs to decide that a close still deserves one, and where to send it. */
export interface ClosedTicketFacts {
  readonly departmentId: string;
  readonly channel: Ticket['channel'];
  readonly contactId: string | null;
  readonly closedAt: Date | null;
  readonly mergedIntoId: string | null;
  readonly deletedAt: Date | null;
  /** The status is the brand's Spam (M1-11's `is_spam`); a merge is `mergedIntoId`. */
  readonly isSpam: boolean;
}

/** One answer, from whichever channel took it. A blank comment is null. */
export interface CsatAnswer {
  readonly rating: number;
  readonly comment: string | null;
  readonly via: CsatAnswerChannel;
  readonly at: Date;
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
        channel: tickets.channel,
        contactId: tickets.contactId,
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

  /** Inserts the survey unless this close already has one; a redelivered job gets undefined. */
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
  ): Promise<CsatResponse | undefined> {
    const [row] = await tx
      .insert(csatResponses)
      .values(values)
      .onConflictDoNothing({ target: [csatResponses.ticketId, csatResponses.closedAt] })
      .returning();

    return row;
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
   * The name of whoever closed the ticket this survey is for, when that was a
   * staff member who is still active in the brand and who wrote to the
   * customer on this ticket; otherwise undefined. The last condition is what
   * keeps the name inside the link's purpose (DOMAIN-RULES §4.6): it names
   * somebody the customer has already had a reply from, nobody new. The
   * close is the latest `ticket.closed` activity row written before the
   * survey was: the survey job runs after the close it is for, and a later
   * close has a survey of its own.
   */
  async closerName(tx: DbTransaction, survey: CsatResponse): Promise<string | undefined> {
    const [row] = await tx
      .select({ name: users.name })
      .from(ticketActivity)
      .innerJoin(users, sql`${users.id}::text = ${ticketActivity.actorId}`)
      .innerJoin(
        userBrandRoles,
        and(
          eq(userBrandRoles.userId, users.id),
          eq(userBrandRoles.brandId, ticketActivity.brandId),
        ),
      )
      .where(
        and(
          eq(ticketActivity.ticketId, survey.ticketId),
          eq(ticketActivity.action, 'ticket.closed'),
          eq(ticketActivity.actorType, 'staff'),
          lte(ticketActivity.createdAt, survey.createdAt),
          eq(users.status, 'active'),
          sql`EXISTS (
            SELECT 1 FROM ${ticketMessages} m
            WHERE m.ticket_id = ${ticketActivity.ticketId}
              AND m.kind = 'public' AND m.author_type = 'staff'
              AND m.author_id = ${ticketActivity.actorId}
          )`,
        ),
      )
      .orderBy(desc(ticketActivity.createdAt))
      .limit(1);

    return row?.name;
  }

  async find(tx: DbTransaction, surveyId: string): Promise<CsatResponse | undefined> {
    const [row] = await tx
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.id, surveyId))
      .limit(1);

    return row;
  }

  /**
   * The survey a Telegram button names, if the chat that pressed it is the
   * ticket's contact's (M8-06). The callback data is the chat's to send, so a
   * survey id alone proves nothing.
   */
  async findForTelegramChat(
    tx: DbTransaction,
    surveyId: string,
    chatId: string,
  ): Promise<CsatResponse | undefined> {
    const [row] = await tx
      .select({ survey: csatResponses })
      .from(csatResponses)
      .innerJoin(tickets, eq(tickets.id, csatResponses.ticketId))
      .innerJoin(
        contactIdentities,
        and(
          eq(contactIdentities.contactId, tickets.contactId),
          eq(contactIdentities.kind, 'telegram'),
          eq(contactIdentities.value, chatId),
        ),
      )
      .where(and(eq(csatResponses.id, surveyId), isNull(tickets.deletedAt)))
      .limit(1);

    return row?.survey;
  }

  /**
   * Records the answer if, and only if, the survey is still open to it. The
   * conditions are in the `WHERE`, so two submissions racing cannot both win:
   * the second finds the survey answered and updates nothing.
   *
   * Open means unanswered and unexpired — and, for the rating page, also a
   * Telegram tap with no comment yet: the tap records the score and the link
   * stays usable once, to add the comment (`Telegram/Chat-EN`, panel 6).
   */
  async rate(
    tx: DbTransaction,
    surveyId: string,
    answer: CsatAnswer,
  ): Promise<CsatResponse | undefined> {
    const unanswered: SQL | undefined =
      answer.via === 'link'
        ? or(
            isNull(csatResponses.ratedAt),
            and(eq(csatResponses.ratedVia, 'telegram'), isNull(csatResponses.comment)),
          )
        : isNull(csatResponses.ratedAt);
    const [row] = await tx
      .update(csatResponses)
      .set({
        rating: answer.rating,
        comment: answer.comment,
        ratedAt: answer.at,
        ratedVia: answer.via,
      })
      .where(
        and(eq(csatResponses.id, surveyId), unanswered, gt(csatResponses.expiresAt, answer.at)),
      )
      .returning();

    return row;
  }

  /** The widget's Skip: nothing recorded, the card not offered again. False once answered. */
  async skip(tx: DbTransaction, surveyId: string, at: Date): Promise<boolean> {
    const updated = await tx
      .update(csatResponses)
      .set({ skippedAt: at })
      .where(
        and(
          eq(csatResponses.id, surveyId),
          isNull(csatResponses.ratedAt),
          isNull(csatResponses.skippedAt),
        ),
      )
      .returning({ id: csatResponses.id });

    return updated.length > 0;
  }

  /** A channel delivered the survey (M8-06). The first delivery is the one kept. */
  async markSent(tx: DbTransaction, surveyId: string, at: Date): Promise<void> {
    await tx
      .update(csatResponses)
      .set({ sentAt: at })
      .where(and(eq(csatResponses.id, surveyId), isNull(csatResponses.sentAt)));
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

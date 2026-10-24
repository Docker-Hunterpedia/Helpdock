import {
  brands,
  contacts,
  type DbTransaction,
  departments,
  notificationPrefs,
  notifications,
  pushSubscriptions,
  teamMembers,
  ticketBulkOperationItems,
  ticketMessages,
  tickets,
  userBrandRoles,
  users,
} from '@helpdock/db';
import {
  type EmailDelivery,
  type EmailSchedule,
  type NotificationKind,
  type NotificationPreferences,
  resolveNotificationPreferences,
  type TicketChannel,
  type TicketPriority,
} from '@helpdock/schemas';
import { and, asc, count, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { departmentScopeOf } from '../staff/roles.js';
import type { StaffFacts } from './recipients.js';

/**
 * Every statement M3-07 runs, in whichever transaction the caller holds: the
 * worker's brand system transaction for fan-out and delivery, the request's
 * for the panel and the preference page. Stateless, so one instance serves
 * both.
 */

export interface TicketFacts {
  readonly id: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly departmentNameAr: string | null;
  readonly assigneeId: string | null;
  readonly teamId: string | null;
  readonly reference: string;
  readonly subject: string;
  readonly priority: TicketPriority;
  readonly contactName: string | null;
}

export interface MessageFacts {
  readonly id: string;
  readonly kind: string;
  readonly authorType: string;
  readonly authorId: string | null;
  readonly bodyText: string;
  readonly channel: string;
}

export interface NewNotificationRow {
  readonly brandId: string;
  readonly userId: string;
  readonly ticketId: string;
  readonly messageId: string | null;
  readonly kind: NotificationKind;
  readonly actorId: string | null;
  readonly detail: Record<string, unknown>;
  readonly sourceEventId: string;
  readonly inApp: boolean;
  readonly email: boolean;
  readonly push: boolean;
  readonly emailState: 'pending' | null;
  /** M14-03. The bulk edit it belongs to. */
  readonly bulkOperationId?: string | null;
}

export interface DeliveryFacts {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly userId: string;
  readonly userName: string;
  readonly userEmail: string;
  readonly userLocale: 'en' | 'ar';
  readonly userDeactivated: boolean;
  readonly ticketId: string;
  readonly messageId: string | null;
  readonly actorName: string | null;
  readonly detail: Record<string, unknown>;
  readonly inApp: boolean;
  readonly email: boolean;
  readonly push: boolean;
  readonly createdAt: Date;
  /** The recipient's pause (M14-10): push waits for nothing while it lasts. */
  readonly pausedUntil: Date | null;
}

export interface PanelRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly ticketId: string;
  readonly reference: string;
  readonly subject: string;
  readonly departmentName: string;
  readonly departmentNameAr: string | null;
  readonly actorName: string | null;
  readonly bodyText: string | null;
  readonly messageChannel: TicketChannel | null;
  readonly detail: Record<string, unknown>;
  /** The bulk edit that caused it (M14-04 folds a person's rows of one into one line). */
  readonly bulkOperationId: string | null;
  /** How many of this person's notifications that operation made; 0 without one. */
  readonly bulkOperationCount: number;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export interface SubscriptionRow {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label: string;
  readonly createdAt: Date;
}

const reference = sql<string>`${tickets.prefix} || '-' || ${tickets.number}::text`;

export class NotificationsRepository {
  // ---------------------------------------------------------------- fan-out

  /** A live ticket's facts, or undefined for one deleted or out of this transaction's sight. */
  async ticket(tx: DbTransaction, ticketId: string): Promise<TicketFacts | undefined> {
    const [row] = await tx
      .select({
        id: tickets.id,
        departmentId: tickets.departmentId,
        departmentName: departments.name,
        departmentNameAr: departments.nameAr,
        assigneeId: tickets.assigneeId,
        teamId: tickets.teamId,
        reference,
        subject: tickets.subject,
        priority: tickets.priority,
        contactName: contacts.name,
      })
      .from(tickets)
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .leftJoin(contacts, eq(contacts.id, tickets.contactId))
      .where(and(eq(tickets.id, ticketId), isNull(tickets.deletedAt)))
      .limit(1);

    return row;
  }

  async message(tx: DbTransaction, messageId: string): Promise<MessageFacts | undefined> {
    const [row] = await tx
      .select({
        id: ticketMessages.id,
        kind: ticketMessages.kind,
        authorType: ticketMessages.authorType,
        authorId: ticketMessages.authorId,
        bodyText: ticketMessages.bodyText,
        channel: ticketMessages.channel,
      })
      .from(ticketMessages)
      .where(eq(ticketMessages.id, messageId))
      .limit(1);

    return row;
  }

  /** Everyone holding a role in the brand, with what decides whether they may see a ticket. */
  async members(tx: DbTransaction, brandId: string): Promise<StaffFacts[]> {
    const rows = await tx
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        departmentIds: userBrandRoles.departmentIds,
        status: users.status,
        deactivatedAt: users.deactivatedAt,
      })
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(eq(userBrandRoles.brandId, brandId))
      .orderBy(asc(users.name), asc(users.id));

    return rows.map((row) => ({
      userId: row.userId,
      name: row.name,
      email: row.email,
      departmentIds: departmentScopeOf(row.departmentIds),
      deactivated: row.deactivatedAt !== null || row.status === 'deactivated',
    }));
  }

  async teamMemberIds(tx: DbTransaction, teamIds: readonly string[]): Promise<string[]> {
    if (teamIds.length === 0) {
      return [];
    }

    const rows = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, [...teamIds]))
      .orderBy(asc(teamMembers.createdAt));

    return rows.map((row) => row.userId);
  }

  /** Team Leaders whose scope reaches the department (DOMAIN-RULES §1.2), for an SLA step that names them. */
  async departmentLeadIds(
    tx: DbTransaction,
    brandId: string,
    departmentId: string,
  ): Promise<string[]> {
    const rows = await tx
      .select({ userId: userBrandRoles.userId })
      .from(userBrandRoles)
      .where(
        and(
          eq(userBrandRoles.brandId, brandId),
          eq(userBrandRoles.role, 'team_leader'),
          or(
            isNull(userBrandRoles.departmentIds),
            sql`${departmentId}::uuid = ANY(${userBrandRoles.departmentIds})`,
          ),
        ),
      )
      .orderBy(asc(userBrandRoles.userId));

    return rows.map((row) => row.userId);
  }

  async preferencesOf(
    tx: DbTransaction,
    userIds: readonly string[],
  ): Promise<Map<string, NotificationPreferences>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const rows = await tx
      .select({ userId: notificationPrefs.userId, preferences: notificationPrefs.preferences })
      .from(notificationPrefs)
      .where(inArray(notificationPrefs.userId, [...userIds]));

    return new Map(
      rows.map((row) => [row.userId, resolveNotificationPreferences(row.preferences)]),
    );
  }

  /**
   * Writes the rows and returns the ids of those that were new. A redelivered
   * event collides on `(source_event_id, user_id)` and returns nothing, so the
   * caller queues nothing a second time.
   */
  async insert(tx: DbTransaction, rows: readonly NewNotificationRow[]): Promise<string[]> {
    if (rows.length === 0) {
      return [];
    }

    const inserted = await tx
      .insert(notifications)
      .values([...rows])
      .onConflictDoNothing({ target: [notifications.sourceEventId, notifications.userId] })
      .returning({ id: notifications.id });

    return inserted.map((row) => row.id);
  }

  /**
   * M14-03. Whether an Undo put this ticket's assignee back, so a notification
   * for the assignment it undid is not made late.
   */
  async bulkAssignmentReverted(
    tx: DbTransaction,
    operationId: string,
    ticketId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: ticketBulkOperationItems.id })
      .from(ticketBulkOperationItems)
      .where(
        and(
          eq(ticketBulkOperationItems.operationId, operationId),
          eq(ticketBulkOperationItems.ticketId, ticketId),
          sql`${ticketBulkOperationItems.reverted} @> '["assigneeId"]'::jsonb`,
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /**
   * M14-03. An Undo takes back what an operation told people on the tickets
   * whose assignee it put back: an email still waiting is withdrawn, and every
   * such notification nobody has read is deleted. One someone has read stays, as
   * the record of what they were told. Runs as the worker: the rows belong to
   * their recipients (the owner policy).
   */
  async withdrawBulkOperation(
    tx: DbTransaction,
    operationId: string,
    ticketIds: readonly string[],
  ): Promise<number> {
    const ofTheseTickets = and(
      eq(notifications.bulkOperationId, operationId),
      inArray(notifications.ticketId, [...ticketIds]),
    );
    await tx
      .update(notifications)
      .set({ emailState: 'withdrawn' })
      .where(and(ofTheseTickets, eq(notifications.emailState, 'pending')));
    const deleted = await tx
      .delete(notifications)
      .where(and(ofTheseTickets, isNull(notifications.readAt)))
      .returning({ id: notifications.id });

    return deleted.length;
  }

  // --------------------------------------------------------------- delivery

  async delivery(tx: DbTransaction, notificationId: string): Promise<DeliveryFacts | undefined> {
    const recipient = users;
    const [row] = await tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        userId: notifications.userId,
        userName: recipient.name,
        userEmail: recipient.email,
        userLocale: recipient.locale,
        deactivatedAt: recipient.deactivatedAt,
        ticketId: notifications.ticketId,
        messageId: notifications.messageId,
        actorId: notifications.actorId,
        detail: notifications.detail,
        inApp: notifications.inApp,
        email: notifications.email,
        push: notifications.push,
        createdAt: notifications.createdAt,
        pausedUntil: notificationPrefs.pausedUntil,
      })
      .from(notifications)
      .innerJoin(recipient, eq(recipient.id, notifications.userId))
      .leftJoin(notificationPrefs, eq(notificationPrefs.userId, notifications.userId))
      .where(eq(notifications.id, notificationId))
      .limit(1);

    if (row === undefined) {
      return undefined;
    }

    const actorName =
      row.actorId === null ? null : ((await this.userName(tx, row.actorId)) ?? null);
    const { deactivatedAt, actorId: _actorId, ...rest } = row;

    return { ...rest, actorName, userDeactivated: deactivatedAt !== null };
  }

  async userName(tx: DbTransaction, userId: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row?.name;
  }

  async subscriptionsOf(tx: DbTransaction, userId: string): Promise<SubscriptionRow[]> {
    return tx
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(asc(pushSubscriptions.createdAt));
  }

  async subscription(
    tx: DbTransaction,
    subscriptionId: string,
  ): Promise<SubscriptionRow | undefined> {
    const [row] = await tx
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, subscriptionId))
      .limit(1);

    return row;
  }

  /** Deletes one of `userId`'s browsers. False when it was not theirs, or not there. */
  async deleteSubscription(
    tx: DbTransaction,
    subscriptionId: string,
    userId?: string,
  ): Promise<boolean> {
    const deleted = await tx
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.id, subscriptionId),
          userId === undefined ? undefined : eq(pushSubscriptions.userId, userId),
        ),
      )
      .returning({ id: pushSubscriptions.id });

    return deleted.length === 1;
  }

  /**
   * One row per endpoint. A browser that subscribes again — after a sign-out
   * and somebody else's sign-in, too — takes the row over, so a shared
   * computer never pushes the previous person's notifications.
   */
  async upsertSubscription(
    tx: DbTransaction,
    values: Omit<SubscriptionRow, 'id' | 'createdAt'>,
  ): Promise<SubscriptionRow> {
    const [row] = await tx
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: values.userId,
          p256dh: values.p256dh,
          auth: values.auth,
          label: values.label,
          createdAt: sql`now()`,
        },
      })
      .returning();

    /* c8 ignore next 3 -- an upsert always returns its row. */
    if (row === undefined) {
      throw new Error('The push subscription upsert returned no row.');
    }

    return row;
  }

  // ------------------------------------------------------------------ panel

  /**
   * One person's notifications in the request's brand, newest first. The
   * inner join to `tickets` runs under the reader's department policy, so a
   * ticket they can no longer see takes its notifications with it.
   */
  async panel(
    tx: DbTransaction,
    {
      brandId,
      userId,
      unreadOnly,
      since,
      limit,
    }: {
      readonly brandId: string;
      readonly userId: string;
      readonly unreadOnly: boolean;
      readonly since: Date;
      readonly limit: number;
    },
  ): Promise<PanelRow[]> {
    const rows = await tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        ticketId: notifications.ticketId,
        reference,
        subject: tickets.subject,
        departmentName: departments.name,
        departmentNameAr: departments.nameAr,
        actorName: sql<
          string | null
        >`(SELECT u.name FROM ${users} u WHERE u.id = ${notifications.actorId})`,
        bodyText: ticketMessages.bodyText,
        messageChannel: ticketMessages.channel,
        detail: notifications.detail,
        bulkOperationId: notifications.bulkOperationId,
        // The whole of the operation's assignments to this person that they can still
        // see, not only the rows in the window or the page, so the bell's "assigned you
        // N" is a total. The join to `tickets` runs under the reader's policy, as the
        // panel's own does, so a ticket in a department they cannot read is not counted.
        bulkOperationCount: sql<number>`(
          SELECT count(*)::int FROM ${notifications} AS same_operation
          INNER JOIN ${tickets} AS visible ON visible.id = same_operation.ticket_id
          WHERE same_operation.bulk_operation_id = ${notifications.bulkOperationId}
            AND same_operation.user_id = ${notifications.userId}
        )`,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .innerJoin(tickets, eq(tickets.id, notifications.ticketId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .leftJoin(ticketMessages, eq(ticketMessages.id, notifications.messageId))
      .where(this.#mine({ brandId, userId, since, unreadOnly }))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);

    return rows;
  }

  async unreadCount(
    tx: DbTransaction,
    { brandId, userId, since }: { brandId: string; userId: string; since: Date },
  ): Promise<number> {
    const [row] = await tx
      .select({ unread: count() })
      .from(notifications)
      .innerJoin(tickets, eq(tickets.id, notifications.ticketId))
      .where(this.#mine({ brandId, userId, since, unreadOnly: true }));

    return row?.unread ?? 0;
  }

  async markRead(
    tx: DbTransaction,
    userId: string,
    notificationId: string,
    at: Date,
  ): Promise<boolean> {
    const updated = await tx
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, ${at.toISOString()}::timestamptz)` })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });

    return updated.length === 1;
  }

  /**
   * Opening a ticket reads what you were told about it (M14-10), so a pending
   * email about it drops out at its send-time re-check. Only the reader's own
   * rows: the owner policy would refuse anyone else's.
   */
  async markTicketRead(
    tx: DbTransaction,
    { userId, ticketId, at }: { userId: string; ticketId: string; at: Date },
  ): Promise<string[]> {
    const rows = await tx
      .update(notifications)
      .set({ readAt: at })
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.ticketId, ticketId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return rows.map((row) => row.id);
  }

  async markAllRead(
    tx: DbTransaction,
    { brandId, userId, at }: { brandId: string; userId: string; at: Date },
  ): Promise<void> {
    await tx
      .update(notifications)
      .set({ readAt: at })
      .where(
        and(
          eq(notifications.brandId, brandId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      );
  }

  // ------------------------------------------------------------ preferences

  async storedPreferences(tx: DbTransaction, userId: string): Promise<unknown> {
    const [row] = await tx
      .select({ preferences: notificationPrefs.preferences })
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId))
      .limit(1);

    return row?.preferences;
  }

  /** M14-10's schedule, digest hour, pause and unsubscribe; the defaults without a row. */
  async emailDelivery(tx: DbTransaction, userId: string): Promise<EmailDelivery> {
    const [row] = await tx
      .select({
        schedule: notificationPrefs.emailSchedule,
        digestHour: notificationPrefs.digestHour,
        pausedUntil: notificationPrefs.pausedUntil,
        unsubscribedAt: notificationPrefs.emailUnsubscribedAt,
      })
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId))
      .limit(1);

    return {
      schedule: row?.schedule ?? 'immediate',
      digestHour: row?.digestHour ?? 8,
      pausedUntil: row?.pausedUntil?.toISOString() ?? null,
      unsubscribedAt: row?.unsubscribedAt?.toISOString() ?? null,
    };
  }

  /** Writes the matrix, and whichever of the email choices are given; the rest stay. */
  async savePreferences(
    tx: DbTransaction,
    userId: string,
    preferences: NotificationPreferences | undefined,
    email: {
      readonly emailSchedule?: EmailSchedule | undefined;
      readonly digestHour?: number | undefined;
      readonly pausedUntil?: Date | null | undefined;
      /** `null` is "Turn email back on"; an unsubscribe goes through {@link unsubscribeEmail}. */
      readonly emailUnsubscribedAt?: null | undefined;
      /** Stamped only when this save lifts an unsubscribe, so unsubscribe links issued before it stop working. */
      readonly resubscribedAt?: Date | undefined;
    } = {},
  ): Promise<void> {
    const { resubscribedAt, ...rest } = email;
    const choices = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    ) as typeof rest;
    await tx
      .insert(notificationPrefs)
      .values({ userId, preferences: preferences ?? {}, ...choices })
      .onConflictDoUpdate({
        target: notificationPrefs.userId,
        set: {
          ...(preferences === undefined ? {} : { preferences }),
          ...choices,
          ...(resubscribedAt === undefined
            ? {}
            : {
                emailResubscribedAt: sql`case when ${notificationPrefs.emailUnsubscribedAt} is not null then ${resubscribedAt.toISOString()}::timestamptz else ${notificationPrefs.emailResubscribedAt} end`,
              }),
          updatedAt: sql`now()`,
        },
      });
  }

  /** When "Turn email back on" last lifted an unsubscribe; null if it never has. */
  async emailResubscribedAt(tx: DbTransaction, userId: string): Promise<Date | null> {
    const [row] = await tx
      .select({ at: notificationPrefs.emailResubscribedAt })
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId))
      .limit(1);

    return row?.at ?? null;
  }

  /**
   * M14-11. Records the unsubscribe and leaves the matrix, the schedule and the
   * pause as they were. True only for the call that changed it: a repeat, or a
   * concurrent twin, finds it already set and writes nothing.
   */
  async unsubscribeEmail(tx: DbTransaction, userId: string, at: Date): Promise<boolean> {
    const changed = await tx
      .insert(notificationPrefs)
      .values({ userId, preferences: {}, emailUnsubscribedAt: at })
      .onConflictDoUpdate({
        target: notificationPrefs.userId,
        set: { emailUnsubscribedAt: at, updatedAt: sql`now()` },
        setWhere: isNull(notificationPrefs.emailUnsubscribedAt),
      })
      .returning({ userId: notificationPrefs.userId });

    return changed.length > 0;
  }

  /** The brand's time zone, which the daily digest's hour is read in for anyone who has not chosen their own. */
  async brandTimeZone(tx: DbTransaction, brandId: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ timeZone: brands.timezone })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return row?.timeZone;
  }

  /** The account a verified unsubscribe token names; undefined once deactivated or gone. */
  async activeAccount(
    tx: DbTransaction,
    userId: string,
  ): Promise<{ email: string; locale: 'en' | 'ar' } | undefined> {
    const [row] = await tx
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deactivatedAt)))
      .limit(1);

    return row;
  }

  async account(
    tx: DbTransaction,
    userId: string,
  ): Promise<{ email: string; locale: 'en' | 'ar'; timeZone: string | null } | undefined> {
    const [row] = await tx
      .select({ email: users.email, locale: users.locale, timeZone: users.timeZone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row;
  }

  // ------------------------------------------------------------- internals

  /**
   * In-app rows only: a notification made for email or push alone is not in
   * the panel, because its recipient chose not to see it there.
   */
  #mine({
    brandId,
    userId,
    since,
    unreadOnly,
  }: {
    brandId: string;
    userId: string;
    since: Date;
    unreadOnly: boolean;
  }) {
    // The brand is named even though the policies narrow to it: a staff
    // transaction may carry every brand its principal works in, and the bell
    // is about the one on screen.
    return and(
      eq(notifications.brandId, brandId),
      eq(notifications.userId, userId),
      eq(notifications.inApp, true),
      gte(notifications.createdAt, since),
      isNull(tickets.deletedAt),
      unreadOnly ? isNull(notifications.readAt) : undefined,
    );
  }
}

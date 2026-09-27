import {
  contacts,
  type DbTransaction,
  departments,
  notificationPrefs,
  notifications,
  pushSubscriptions,
  teamMembers,
  ticketMessages,
  tickets,
  userBrandRoles,
  users,
} from '@helpdock/db';
import {
  type NotificationKind,
  type NotificationPreferences,
  resolveNotificationPreferences,
  type TicketChannel,
  type TicketPriority,
} from '@helpdock/schemas';
import { and, asc, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
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
      })
      .from(notifications)
      .innerJoin(recipient, eq(recipient.id, notifications.userId))
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

  async savePreferences(
    tx: DbTransaction,
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<void> {
    await tx
      .insert(notificationPrefs)
      .values({ userId, preferences })
      .onConflictDoUpdate({
        target: notificationPrefs.userId,
        set: { preferences, updatedAt: sql`now()` },
      });
  }

  async account(
    tx: DbTransaction,
    userId: string,
  ): Promise<{ email: string; locale: 'en' | 'ar' } | undefined> {
    const [row] = await tx
      .select({ email: users.email, locale: users.locale })
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

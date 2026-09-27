import type { DbTransaction } from '@helpdock/db';
import {
  enqueueOutbox,
  type NotifyEmailPayload,
  type NotifyPushPayload,
  notifyEmailJob,
  notifyPushJob,
  type OutboxEventContext,
  type OutboxEventHandler,
  registerEventHandler,
} from '@helpdock/jobs';
import {
  type NotificationDetail,
  type NotificationKind,
  REALTIME_EVENTS,
  slaClockSchema,
  userRoom,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { RealtimeBroadcast } from '../realtime/broadcast.js';
import {
  TICKET_ASSIGNED_EVENT,
  TICKET_EVENTS,
  ticketAssignedPayloadSchema,
  ticketEventPayloadSchema,
} from '../tickets/ticket-events.js';
import type {
  MessageFacts,
  NotificationsRepository,
  TicketFacts,
} from './notifications.repository.js';
import { channelsFor, eligibleRecipients, mentionedStaff, type StaffFacts } from './recipients.js';

/**
 * M3-07's side effects, the long way round DOMAIN-RULES §6 requires.
 *
 * ```
 * domain change  →  outbox: ticket.assigned, sla.breached, …      (its own transaction)
 * worker         →  notifications rows + outbox: notification.created (one per row)
 * worker         →  socket frame, and notify.email / notify.push jobs (after that commits)
 * worker         →  one email, one push per browser                (idempotent jobs)
 * ```
 *
 * The middle hop is why nothing here can send twice or send about a row that
 * rolled back: a job is only added by the `notification.created` handler, which
 * runs after the rows it names have committed, and each job id is derived from
 * the row, so a redelivered event adds nothing new.
 *
 * | Event | Written by | Who is told |
 * |---|---|---|
 * | `ticket.assigned` | a person, the rotation (M1-07), a rule (M3-03) | the new assignee |
 * | `ticket.replied` | a public message | the assignee, when the contact wrote it |
 * | `ticket.note_added` | an internal note | everyone it `@`-mentions |
 * | `sla.warning` | the SLA engine (M3-02) | the assignee |
 * | `sla.breached` | the SLA engine | the assignee, or the ticket's team when nobody holds it |
 * | `ticket.escalated` | an SLA step or a rule | the users and teams it names, or else the assignee and team |
 */

export const NOTIFICATION_EVENTS = {
  created: 'notification.created',
  pushTest: 'notification.push_test',
} as const;

/** What the notifications module subscribes as, beside each event's own handler. */
export const NOTIFICATIONS_SUBSCRIBER = 'notifications';

/** The SLA agent's contract (M3-02). Extra keys are ignored, so it may carry more. */
export const SLA_EVENTS = {
  warning: 'sla.warning',
  breached: 'sla.breached',
} as const;
export const TICKET_ESCALATED_EVENT = 'ticket.escalated';

export const slaWarningPayloadSchema = z.object({
  ticketId: z.uuid(),
  clock: slaClockSchema,
  stepPercent: z.int().nonnegative(),
});

export const slaBreachedPayloadSchema = z.object({
  ticketId: z.uuid(),
  clock: slaClockSchema,
});

export const ticketEscalatedPayloadSchema = z.object({
  ticketId: z.uuid(),
  /** People an escalation step's "notify" action names. */
  userIds: z.array(z.uuid()).optional(),
  /** Teams it names; each member is told by their own settings. */
  teamIds: z.array(z.uuid()).optional(),
  clock: slaClockSchema.optional(),
  stepPercent: z.int().nonnegative().optional(),
});

export const notificationCreatedPayloadSchema = z.object({ notificationId: z.uuid() });
export const pushTestPayloadSchema = z.object({
  userId: z.uuid(),
  subscriptionId: z.uuid(),
});

// ------------------------------------------------------------------ fan-out

/** What one source event means, once its payload is read. */
export interface NotificationPlan {
  readonly kind: NotificationKind;
  readonly ticketId: string;
  readonly messageId: string | null;
  readonly actorId: string | null;
  readonly detail: NotificationDetail;
  /** Who might be told, before scope, activity and "not yourself" are applied. */
  candidates(input: CandidateInput): Promise<readonly string[]>;
}

export interface CandidateInput {
  readonly tx: DbTransaction;
  readonly ticket: TicketFacts;
  readonly message: MessageFacts | undefined;
  readonly members: readonly StaffFacts[];
  readonly repository: NotificationsRepository;
}

const assignee = ({ ticket }: CandidateInput): Promise<readonly string[]> =>
  Promise.resolve(ticket.assigneeId === null ? [] : [ticket.assigneeId]);

const assigneeOrTeam = async ({
  tx,
  ticket,
  repository,
}: CandidateInput): Promise<readonly string[]> => {
  if (ticket.assigneeId !== null) {
    return [ticket.assigneeId];
  }

  return ticket.teamId === null ? [] : repository.teamMemberIds(tx, [ticket.teamId]);
};

/**
 * Turns a source event into a plan, or null when it tells nobody anything: an
 * agent's own reply, a note without a mention. Exported so each rule is
 * provable on its own.
 */
export const planFor = (
  event: string,
  payload: Record<string, unknown>,
): NotificationPlan | null => {
  switch (event) {
    case TICKET_ASSIGNED_EVENT: {
      const parsed = ticketAssignedPayloadSchema.parse(payload);
      return {
        kind: 'assigned',
        ticketId: parsed.ticketId,
        messageId: null,
        actorId: parsed.actorId,
        detail: { assignedBy: parsed.assignedBy },
        // The payload's assignee, not the ticket's current one: if it has
        // changed hands again since, the later event tells the later person.
        candidates: () => Promise.resolve([parsed.assigneeId]),
      };
    }
    case TICKET_EVENTS.replied: {
      const parsed = ticketEventPayloadSchema.parse(payload);
      if (parsed.messageId === undefined || parsed.kind !== 'public') {
        return null;
      }
      return {
        kind: 'replied',
        ticketId: parsed.ticketId,
        messageId: parsed.messageId,
        actorId: null,
        detail: {},
        // "The contact answers on a ticket assigned to you": a colleague's
        // reply on your ticket is not what this setting is about.
        candidates: (input) =>
          input.message?.authorType === 'contact' ? assignee(input) : Promise.resolve([]),
      };
    }
    case TICKET_EVENTS.noteAdded: {
      const parsed = ticketEventPayloadSchema.parse(payload);
      if (parsed.messageId === undefined) {
        return null;
      }
      return {
        kind: 'mentioned',
        ticketId: parsed.ticketId,
        messageId: parsed.messageId,
        actorId: null,
        detail: {},
        candidates: ({ message, members }) =>
          Promise.resolve(
            message === undefined
              ? []
              : mentionedStaff(message.bodyText, members).map((member) => member.userId),
          ),
      };
    }
    case SLA_EVENTS.warning: {
      const parsed = slaWarningPayloadSchema.parse(payload);
      return {
        kind: 'sla_warning',
        ticketId: parsed.ticketId,
        messageId: null,
        actorId: null,
        detail: { clock: parsed.clock, stepPercent: parsed.stepPercent },
        candidates: assignee,
      };
    }
    case SLA_EVENTS.breached: {
      const parsed = slaBreachedPayloadSchema.parse(payload);
      return {
        kind: 'sla_breached',
        ticketId: parsed.ticketId,
        messageId: null,
        actorId: null,
        detail: { clock: parsed.clock },
        candidates: assigneeOrTeam,
      };
    }
    case TICKET_ESCALATED_EVENT: {
      const parsed = ticketEscalatedPayloadSchema.parse(payload);
      const named = [...(parsed.userIds ?? [])];
      const teams = parsed.teamIds ?? [];
      return {
        kind: 'escalated',
        ticketId: parsed.ticketId,
        messageId: null,
        actorId: null,
        detail: {
          ...(parsed.clock === undefined ? {} : { clock: parsed.clock }),
          ...(parsed.stepPercent === undefined ? {} : { stepPercent: parsed.stepPercent }),
        },
        // An escalation that names nobody goes to whoever the ticket is with:
        // its assignee and its team.
        candidates: async ({ tx, ticket, repository }) => {
          const explicit = named.length > 0 || teams.length > 0;
          const users = explicit ? named : ticket.assigneeId === null ? [] : [ticket.assigneeId];
          const teamIds = explicit ? teams : ticket.teamId === null ? [] : [ticket.teamId];
          return [...users, ...(await repository.teamMemberIds(tx, teamIds))];
        },
      };
    }
    default:
      return null;
  }
};

/** The events this module consumes. */
export const CONSUMED_EVENTS = [
  TICKET_ASSIGNED_EVENT,
  TICKET_EVENTS.replied,
  TICKET_EVENTS.noteAdded,
  SLA_EVENTS.warning,
  SLA_EVENTS.breached,
  TICKET_ESCALATED_EVENT,
] as const;

export interface FanOutDeps {
  readonly repository: NotificationsRepository;
  /** Whether the install has a VAPID key pair; push is off without one. */
  pushConfigured(): Promise<boolean>;
}

export const createFanOutHandler =
  ({ repository, pushConfigured }: FanOutDeps): OutboxEventHandler =>
  async ({ tx, brandId, event, outboxId, payload, log }: OutboxEventContext): Promise<void> => {
    const plan = planFor(event, payload);
    if (plan === null) {
      return;
    }

    const ticket = await repository.ticket(tx, plan.ticketId);
    if (ticket === undefined) {
      // Deleted, or purged, since the event was written: nothing to point at.
      return;
    }

    const [message, members] = await Promise.all([
      plan.messageId === null ? Promise.resolve(undefined) : repository.message(tx, plan.messageId),
      repository.members(tx, brandId),
    ]);

    const recipients = eligibleRecipients({
      candidateIds: await plan.candidates({ tx, ticket, message, members, repository }),
      members,
      departmentId: ticket.departmentId,
      actorId: plan.actorId ?? message?.authorId ?? null,
    });
    if (recipients.length === 0) {
      return;
    }

    const [preferences, push] = await Promise.all([
      repository.preferencesOf(
        tx,
        recipients.map((recipient) => recipient.userId),
      ),
      pushConfigured(),
    ]);

    const rows = recipients.flatMap((recipient) => {
      const channels = channelsFor(preferences.get(recipient.userId), plan.kind, {
        pushConfigured: push,
      });
      if (!channels.any) {
        return [];
      }
      return [
        {
          brandId,
          userId: recipient.userId,
          ticketId: ticket.id,
          messageId: plan.messageId,
          kind: plan.kind,
          actorId: plan.actorId ?? staffAuthor(message, members),
          detail: plan.detail,
          sourceEventId: outboxId,
          inApp: channels.inApp,
          email: channels.email,
          push: channels.push,
        },
      ];
    });

    const ids = await repository.insert(tx, rows);
    for (const notificationId of ids) {
      await enqueueOutbox(tx, {
        brandId,
        event: NOTIFICATION_EVENTS.created,
        payload: { notificationId },
      });
    }

    log.info(
      { event, outboxId, brandId, kind: plan.kind, notified: ids.length },
      'notifications written',
    );
  };

/** The note's author, when a member of staff wrote it: "Omar Nasser mentioned you". */
const staffAuthor = (
  message: MessageFacts | undefined,
  members: readonly StaffFacts[],
): string | null =>
  message?.authorType === 'staff' && members.some((member) => member.userId === message.authorId)
    ? message.authorId
    : null;

// ----------------------------------------------------------------- delivery

/** Adds a job to the `notify` queue. The worker passes BullMQ; tests pass a recorder. */
export interface NotifyQueue {
  addEmail(jobId: string, payload: NotifyEmailPayload): Promise<void>;
  addPush(jobId: string, payload: NotifyPushPayload): Promise<void>;
}

export interface DeliveryDeps {
  readonly repository: NotificationsRepository;
  readonly broadcast: RealtimeBroadcast;
  readonly queue: NotifyQueue;
}

/** BullMQ refuses a custom id with a colon in it, so the parts are joined with dots. */
export const emailJobId = (notificationId: string): string =>
  `${notifyEmailJob.name}.${notificationId}`;
export const pushJobId = (subscriptionId: string, key: string): string =>
  `${notifyPushJob.name}.${subscriptionId}.${key}`;

export const createNotificationCreatedHandler =
  ({ repository, broadcast, queue }: DeliveryDeps): OutboxEventHandler =>
  async ({ tx, brandId, payload }: OutboxEventContext): Promise<void> => {
    const { notificationId } = notificationCreatedPayloadSchema.parse(payload);
    const notification = await repository.delivery(tx, notificationId);
    if (notification === undefined || notification.userDeactivated) {
      return;
    }

    if (notification.inApp) {
      await broadcast.emit({
        rooms: [userRoom(notification.userId)],
        event: REALTIME_EVENTS.notificationCreated,
        data: { brandId, notificationId },
        seq: null,
      });
    }

    if (notification.email) {
      await queue.addEmail(emailJobId(notificationId), { brandId, notificationId });
    }

    if (notification.push) {
      for (const subscription of await repository.subscriptionsOf(tx, notification.userId)) {
        await queue.addPush(pushJobId(subscription.id, notificationId), {
          brandId,
          subscriptionId: subscription.id,
          notificationId,
        });
      }
    }
  };

/** "Send a test" on the Notifications tab: one push to one browser of the person who pressed it. */
export const createPushTestHandler =
  ({ repository, queue }: Pick<DeliveryDeps, 'repository' | 'queue'>): OutboxEventHandler =>
  async ({ tx, brandId, outboxId, payload }: OutboxEventContext): Promise<void> => {
    const { userId, subscriptionId } = pushTestPayloadSchema.parse(payload);
    const subscription = await repository.subscription(tx, subscriptionId);
    if (subscription?.userId !== userId) {
      return;
    }

    await queue.addPush(pushJobId(subscriptionId, outboxId), {
      brandId,
      subscriptionId,
      testId: outboxId,
    });
  };

/**
 * Called by the worker's start-up, after the tickets module has registered its
 * own handlers, so on the events both handle the socket frame goes first.
 *
 * The consumed events are registered as a named subscriber, never as an
 * event's default handler: the module that owns an event — the tickets module
 * for `ticket.replied`, the SLA engine for `sla.breached` — keeps that slot.
 */
export const registerNotificationHandlers = (deps: FanOutDeps & DeliveryDeps): void => {
  const fanOut = createFanOutHandler(deps);
  for (const event of CONSUMED_EVENTS) {
    registerEventHandler(event, fanOut, NOTIFICATIONS_SUBSCRIBER);
  }

  registerEventHandler(NOTIFICATION_EVENTS.created, createNotificationCreatedHandler(deps));
  registerEventHandler(NOTIFICATION_EVENTS.pushTest, createPushTestHandler(deps));
};

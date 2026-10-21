import { z } from 'zod';
import { ticketChannelSchema } from './ticket.js';
import { RULE_NOTIFY_MESSAGE_MAX_LENGTH } from './workflow-rules.js';

/**
 * Staff notifications (M3-07, REQUIREMENTS §4.9): what a person is told about,
 * through which channels, and what the bell's panel draws.
 *
 * Shared by the api, which validates every request and response through these,
 * and the admin app, which parses what it receives.
 */

// ------------------------------------------------------------------ kinds

/** The six events of REQUIREMENTS §4.9, in the order the preference table lists them. */
export const NOTIFICATION_KINDS = [
  'assigned',
  'replied',
  'mentioned',
  'sla_warning',
  'sla_breached',
  'escalated',
  /** M14-02. A snooze ended by time or by an SLA step; the assignee, else the person who snoozed it. */
  'snooze_ended',
] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/** The three channels. In-app is the bell; push is the browser (ADR 0002). */
export const NOTIFICATION_CHANNELS = ['inApp', 'email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** The SLA clocks of DOMAIN-RULES §3.1 and §3.5, as the SLA engine names them. */
export const slaClockSchema = z.enum(['first_response', 'next_response', 'resolution']);
export type SlaClock = z.infer<typeof slaClockSchema>;

// ------------------------------------------------------------ preferences

export const notificationChannelsSchema = z.strictObject({
  inApp: z.boolean(),
  email: z.boolean(),
  push: z.boolean(),
});
export type NotificationChannels = z.infer<typeof notificationChannelsSchema>;

export const notificationPreferencesSchema = z.strictObject({
  assigned: notificationChannelsSchema,
  replied: notificationChannelsSchema,
  mentioned: notificationChannelsSchema,
  sla_warning: notificationChannelsSchema,
  sla_breached: notificationChannelsSchema,
  escalated: notificationChannelsSchema,
  snooze_ended: notificationChannelsSchema,
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/**
 * What somebody who never opened the page gets, as the `AdminNotifications`
 * artboard draws it: everything in-app; email for what cannot wait or was
 * addressed to you by name; push for what is yours to answer now.
 */
export const NOTIFICATION_PREFERENCE_DEFAULTS: NotificationPreferences = Object.freeze({
  assigned: { inApp: true, email: true, push: true },
  replied: { inApp: true, email: false, push: true },
  mentioned: { inApp: true, email: true, push: true },
  sla_warning: { inApp: true, email: false, push: false },
  sla_breached: { inApp: true, email: true, push: true },
  escalated: { inApp: true, email: true, push: false },
  // In-app and push by default, email off (M14-02).
  snooze_ended: { inApp: true, email: false, push: true },
});

/**
 * A stored row read back. Anything missing or malformed — a kind added after
 * the row was saved — falls back to its default rather than failing the read.
 */
export const resolveNotificationPreferences = (stored: unknown): NotificationPreferences => {
  const record = typeof stored === 'object' && stored !== null ? stored : {};
  const resolved = { ...NOTIFICATION_PREFERENCE_DEFAULTS };

  for (const kind of NOTIFICATION_KINDS) {
    const parsed = notificationChannelsSchema.safeParse((record as Record<string, unknown>)[kind]);
    if (parsed.success) {
      resolved[kind] = parsed.data;
    }
  }

  return resolved;
};

// ------------------------------------------------------- email schedule

/**
 * How notification email reaches a person (M14-10, DOMAIN-RULES §20): Right
 * away, paced and batched (the default, owner decision D-25), an hourly or a
 * daily digest per brand, or none.
 */
export const EMAIL_SCHEDULES = ['immediate', 'hourly', 'daily', 'off'] as const;
export const emailScheduleSchema = z.enum(EMAIL_SCHEDULES);
export type EmailSchedule = z.infer<typeof emailScheduleSchema>;

/** A pause runs for at most this long; "until a date" is capped here. */
export const NOTIFICATION_PAUSE_MAX_DAYS = 365;

export const emailDeliverySchema = z.object({
  schedule: emailScheduleSchema,
  /** The daily digest's hour, 0–23, in the person's time zone. */
  digestHour: z.int().min(0).max(23),
  /** Email and push are dropped, never delayed, until then; null when not paused. */
  pausedUntil: z.iso.datetime().nullable(),
  /** Set by M14-11's one-click unsubscribe; null while email is on. */
  unsubscribedAt: z.iso.datetime().nullable(),
});
export type EmailDelivery = z.infer<typeof emailDeliverySchema>;

export const pushSubscriptionSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  createdAt: z.iso.datetime(),
});
export type PushSubscriptionView = z.infer<typeof pushSubscriptionSchema>;

/** `GET /api/me/notification-preferences`: everything the Notifications tab draws. */
export const notificationPreferencesViewSchema = z.object({
  preferences: notificationPreferencesSchema,
  /** Where email notifications go, and the language they are written in. */
  email: z.string(),
  locale: z.enum(['en', 'ar']),
  push: z.object({
    /** False until an install admin sets the VAPID key pair. */
    configured: z.boolean(),
    /** The `applicationServerKey`; null when push is not configured. */
    publicKey: z.string().nullable(),
    subscriptions: z.array(pushSubscriptionSchema),
  }),
  emailDelivery: emailDeliverySchema,
  /** False while the install has no SMTP settings: notification emails cannot be sent at all. */
  emailConfigured: z.boolean(),
  /**
   * The time zone the daily digest's hour is read in (the current brand's until
   * M14-12 gives people their own); null when the request names no brand.
   */
  digestTimeZone: z.string().nullable(),
});
export type NotificationPreferencesView = z.infer<typeof notificationPreferencesViewSchema>;

/**
 * `PUT /api/me/notification-preferences`. Every part is optional, so the
 * matrix, the schedule and a pause can each be saved on their own; a
 * `pausedUntil` of null resumes.
 */
export const notificationPreferencesUpdateSchema = z
  .strictObject({
    preferences: notificationPreferencesSchema.optional(),
    emailSchedule: emailScheduleSchema.optional(),
    digestHour: z.int().min(0).max(23).optional(),
    pausedUntil: z.iso.datetime().nullable().optional(),
    /** `false` is "Turn email back on" after an unsubscribe; only the person's own unsubscribe sets it. */
    emailUnsubscribed: z.literal(false).optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: 'must change something',
  });
export type NotificationPreferencesUpdate = z.infer<typeof notificationPreferencesUpdateSchema>;

// -------------------------------------------------- one-click unsubscribe

/** DOMAIN-RULES §4.6: an unsubscribe link works for a year from the email that carried it. */
export const UNSUBSCRIBE_TOKEN_TTL_DAYS = 365;

/**
 * `<20 bytes>.<32 bytes>`, both base64url: the user id and the issue time, and
 * the HMAC over them. Checked before anything is computed, so a malformed
 * path is refused without a lookup.
 */
export const UNSUBSCRIBE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/;

export const unsubscribeTokenParamSchema = z.object({
  token: z.string().regex(UNSUBSCRIBE_TOKEN_PATTERN),
});

/**
 * RFC 8058 section 3.1: the body a mail client's one-click POST carries. The
 * confirmation page sends the same body, so the two take one path.
 */
export const unsubscribeRequestSchema = z.strictObject({
  'List-Unsubscribe': z.literal('One-Click'),
});

/**
 * What the public page draws. `confirm` names the address the link is for,
 * which only its holder can see; `done` is the answer to the unsubscribe, a
 * first one or a repeat. A forged, altered, expired or unknown token is a 404,
 * the same one for each, so the page never says whether an address exists.
 */
export const unsubscribeViewSchema = z.object({
  state: z.enum(['confirm', 'done']),
  /** Present on `confirm` only. */
  email: z.string().optional(),
  locale: z.enum(['en', 'ar']),
});
export type UnsubscribeView = z.infer<typeof unsubscribeViewSchema>;

/** Base64url, as `PushSubscription.toJSON()` hands the keys over. */
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * `POST /api/me/push-subscriptions`, from `PushSubscription.toJSON()`. The
 * endpoint is a push service's URL and must be https: a browser never issues
 * anything else, and the worker sends to it.
 */
export const pushSubscriptionCreateSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.strictObject({
    p256dh: z.string().min(1).max(256).regex(BASE64URL),
    auth: z.string().min(1).max(64).regex(BASE64URL),
  }),
  label: z.string().trim().max(80).default(''),
});
export type PushSubscriptionCreate = z.input<typeof pushSubscriptionCreateSchema>;

export const pushSubscriptionParamSchema = z.object({ subscriptionId: z.uuid() });

// -------------------------------------------------------------- the panel

/** Kind-specific facts. Every field is optional because each kind uses a few. */
export const notificationDetailSchema = z.object({
  /** `sla_warning`, `sla_breached`, `escalated` from an SLA step. */
  clock: slaClockSchema.optional(),
  /** `sla_warning` and `escalated`: the step that fired, as a percentage of the target. */
  stepPercent: z.int().nonnegative().optional(),
  /** `assigned`: who chose the assignee. */
  assignedBy: z.enum(['person', 'rule', 'round_robin', 'skill_based', 'sla']).optional(),
  /** `snooze_ended`: what woke the ticket. */
  wokeBy: z.enum(['time', 'sla']).optional(),
  /** `escalated` by a workflow rule's "notify" action (M3-03): the rule. */
  ruleId: z.uuid().optional(),
  /** Its message, when the rule has one of its own. */
  message: z.string().max(RULE_NOTIFY_MESSAGE_MAX_LENGTH).optional(),
});
export type NotificationDetail = z.infer<typeof notificationDetailSchema>;

/** One row of the panel. Subject and names are read live, never stored (see the table). */
export const notificationSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  ticketId: z.uuid(),
  ticketReference: z.string(),
  subject: z.string(),
  departmentName: z.string(),
  /** The department's Arabic name, when it has one; the admin picks by its language. */
  departmentNameAr: z.string().nullable(),
  /** Who caused it; null for the system. */
  actorName: z.string().nullable(),
  /** The first words of the note or reply it is about. */
  excerpt: z.string().nullable(),
  /** The channel of that reply, for "Email · 2 h ago". */
  messageChannel: ticketChannelSchema.nullable(),
  detail: notificationDetailSchema,
  /** The bulk edit that caused it (M14-04): the panel folds one operation's `assigned` rows into one line. */
  bulkOperationId: z.uuid().nullable(),
  /** How many assignments that operation made to the reader in all (0 without one), which the folded line says. */
  bulkOperationCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type NotificationView = z.infer<typeof notificationSchema>;

/** The panel's window, in days. Older rows are not listed (artboard: "Last 30 days"). */
export const NOTIFICATION_WINDOW_DAYS = 30;
export const NOTIFICATION_PAGE_SIZE = 50;

export const notificationListQuerySchema = z.object({
  filter: z.enum(['all', 'unread']).default('all'),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.int().nonnegative(),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const notificationParamSchema = z.object({
  brandId: z.uuid(),
  notificationId: z.uuid(),
});

export const pushTestRequestSchema = z.strictObject({ subscriptionId: z.uuid() });
export type PushTestRequest = z.infer<typeof pushTestRequestSchema>;

/** Excerpts are cut to this many characters, on a word boundary where there is one. */
export const NOTIFICATION_EXCERPT_LENGTH = 140;

export const excerptOf = (text: string, length = NOTIFICATION_EXCERPT_LENGTH): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= length) {
    return flat;
  }

  const cut = flat.slice(0, length);
  const space = cut.lastIndexOf(' ');

  return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

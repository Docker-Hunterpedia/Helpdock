import { z } from 'zod';
import { ticketChannelSchema } from './ticket.js';

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
});
export type NotificationPreferencesView = z.infer<typeof notificationPreferencesViewSchema>;

export const notificationPreferencesUpdateSchema = z.strictObject({
  preferences: notificationPreferencesSchema,
});
export type NotificationPreferencesUpdate = z.infer<typeof notificationPreferencesUpdateSchema>;

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
  assignedBy: z.enum(['person', 'rule', 'round_robin', 'skill_based']).optional(),
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

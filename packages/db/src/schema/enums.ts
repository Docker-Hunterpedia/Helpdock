import { pgEnum } from 'drizzle-orm/pg-core';

/** Interface and content languages Helpdock ships with (REQUIREMENTS §3). */
export const localeEnum = pgEnum('locale', ['en', 'ar']);

/** Staff account state (DOMAIN-RULES §12). */
export const userStatusEnum = pgEnum('user_status', ['invited', 'active', 'deactivated']);

/** Brand state. `deleting` is the 30-day grace window of DOMAIN-RULES §11. */
export const brandStatusEnum = pgEnum('brand_status', ['active', 'deleting', 'deleted']);

/** One role per user per brand (DOMAIN-RULES §1.2). */
export const brandRoleEnum = pgEnum('brand_role', ['admin', 'team_leader', 'agent', 'viewer']);

/** The principal kinds of DOMAIN-RULES §1.1, as recorded on an audit row. */
export const actorTypeEnum = pgEnum('actor_type', ['staff', 'visitor', 'apikey', 'system']);

/** What a brand hostname is for (ARCHITECTURE §5). */
export const brandDomainKindEnum = pgEnum('brand_domain_kind', ['helpcenter', 'widget_origin']);

/**
 * The four system states of DOMAIN-RULES §2.1. Every status maps to one of
 * them, so SLA maths and reports stay the same however a brand names its
 * statuses.
 */
export const ticketSystemStateEnum = pgEnum('ticket_system_state', [
  'open',
  'on_hold',
  'escalated',
  'closed',
]);

/** REQUIREMENTS §4.1. The labels shown to people are editable; these keys are not. */
export const ticketPriorityEnum = pgEnum('ticket_priority', ['low', 'medium', 'high', 'urgent']);

/** Where a ticket or one of its messages came from (REQUIREMENTS §4.1). */
export const ticketChannelEnum = pgEnum('ticket_channel', [
  'email',
  'chat',
  'telegram',
  'form',
  'api',
  'manual',
]);

/**
 * What a row in the thread is. `public` reaches the contact, `note` never
 * leaves the desk, `system` is the trail the thread shows inline, and `ai` is a
 * model-written answer (DOMAIN-RULES §2, §9).
 */
export const ticketMessageKindEnum = pgEnum('ticket_message_kind', [
  'public',
  'note',
  'system',
  'ai',
]);

/**
 * Who wrote a message. Close to {@link actorTypeEnum} but not the same list: a
 * message is written by a *contact*, while an audit row is written by whatever
 * principal made the request, which may be a visitor with no contact yet.
 */
export const messageAuthorTypeEnum = pgEnum('message_author_type', [
  'staff',
  'contact',
  'system',
  'ai',
]);

/** "Every state change with who/when/via what (UI, rule, API, AI)" — REQUIREMENTS §4.1. */
export const activityViaEnum = pgEnum('activity_via', ['ui', 'rule', 'api', 'ai', 'system']);

/**
 * The hue a status badge is drawn in: exactly the five status names of DESIGN
 * §2.1, because "a new meaning gets a shape or an icon, not a color". A key
 * rather than a hex value, so a theme change never has to rewrite rows and a
 * brand cannot smuggle a sixth colour in through a status name.
 */
export const statusColorEnum = pgEnum('status_color', [
  'success',
  'warning',
  'danger',
  'info',
  'escalated',
]);

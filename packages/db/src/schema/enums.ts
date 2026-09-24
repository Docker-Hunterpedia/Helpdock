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
 * How a contact can be reached, and how Helpdock recognises them again
 * (DOMAIN-RULES §4.4). `external` is the brand's own user id, carried by a
 * signed identity; `visitor` is the id the widget issues on first load.
 */
export const contactIdentityKindEnum = pgEnum('contact_identity_kind', [
  'email',
  'phone',
  'telegram',
  'visitor',
  'external',
]);

/** What became of a possible-duplicate suggestion (DOMAIN-RULES §4.4). */
export const contactDuplicateStatusEnum = pgEnum('contact_duplicate_status', [
  'open',
  'dismissed',
  'merged',
]);

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

/**
 * What an attachment is, which decides what the media pipeline does to it
 * (ARCHITECTURE §9). `audio` is read against the brand's **voice** policy;
 * REQUIREMENTS §4.6 names the control and the pipeline names the bytes.
 */
export const attachmentKindEnum = pgEnum('attachment_kind', ['image', 'video', 'audio', 'file']);

/**
 * Where an attachment is in the pipeline. `ready` is the only state a presigned
 * download is issued for, because it is the only one whose bytes have been
 * sniffed, re-encoded and scanned.
 */
export const attachmentStatusEnum = pgEnum('attachment_status', [
  'pending',
  'processing',
  'ready',
  'rejected',
  'infected',
]);

/** The outcome of the optional ClamAV pass (ARCHITECTURE §9, §17). */
export const attachmentScanStatusEnum = pgEnum('attachment_scan_status', [
  'skipped',
  'clean',
  'infected',
  'error',
]);

/**
 * Who uploaded an attachment. Narrower than {@link messageAuthorTypeEnum}: an
 * AI writes text and uploads nothing in v1 (AGENTS.md).
 */
export const attachmentUploaderTypeEnum = pgEnum('attachment_uploader_type', [
  'staff',
  'contact',
  'system',
]);

/**
 * Why an attachment was refused. A closed vocabulary, because the value is
 * returned to the client and written to the log: a tool's stderr would carry
 * the worker's paths and the name of every binary on it.
 */
export const attachmentRejectReasonEnum = pgEnum('attachment_reject_reason', [
  'mime_mismatch',
  'mime_not_allowed',
  'kind_disabled',
  'too_large',
  'object_missing',
  'unreadable',
  'timeout',
  'scan_error',
  'infected',
  'processing_failed',
]);

/**
 * The eight tints a tag may be drawn in (DESIGN §6.2): the four status tints a
 * tag is allowed to borrow, and four steps of the warm neutral ramp. The danger
 * tint is deliberately absent — red means "breached" or "destructive" on this
 * desk, and a tag a brand invents must never be able to claim it.
 *
 * A key rather than a hex value, for the reason {@link statusColorEnum} gives:
 * a theme change never rewrites rows, and a brand cannot smuggle a ninth colour
 * in through a tag name.
 */
export const tagColorEnum = pgEnum('tag_color', [
  'info',
  'success',
  'warning',
  'escalated',
  'sand',
  'stone',
  'clay',
  'bark',
]);

/** What a custom field hangs off (REQUIREMENTS §4.1). */
export const customFieldTargetEnum = pgEnum('custom_field_target', [
  'ticket',
  'contact',
  'account',
]);

/**
 * The six field types of REQUIREMENTS §4.1. The list is closed: every type has
 * a validator in `@helpdock/schemas/custom-fields` and an editor in the admin,
 * so a seventh is a deliberate change in three places rather than a row a brand
 * can write.
 */
export const customFieldTypeEnum = pgEnum('custom_field_type', [
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'checkbox',
]);

/**
 * How a department hands new tickets out (M1-07, REQUIREMENTS §4.1). `manual`
 * leaves them unassigned; the other two run the rotation of
 * `apps/api/src/assignment/rotation.ts`.
 */
export const assignmentModeEnum = pgEnum('assignment_mode', [
  'manual',
  'round_robin',
  'skill_based',
]);

/**
 * What happens to a ticket whose assignee can no longer work it — deactivated,
 * removed from the brand, or moved out of its department (DOMAIN-RULES §12).
 */
export const onUnassignEnum = pgEnum('on_unassign', ['round_robin', 'leave_unassigned']);

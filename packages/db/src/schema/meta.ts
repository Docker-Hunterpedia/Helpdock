import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contacts } from './contacts.js';
import { departments } from './departments.js';
import {
  metaAccountStatusEnum,
  metaDeliveryStatusEnum,
  metaPlatformEnum,
  metaTokenKindEnum,
} from './enums.js';
import { ticketMessages } from './ticket-messages.js';
import { tickets } from './tickets.js';
import { users } from './users.js';

/**
 * A WhatsApp number, a Facebook Page or an Instagram professional account a
 * brand answers through (M10-01, ADR 0025). A brand may connect several; each
 * files new conversations into its own department.
 *
 * **`(platform, external_id)` is unique across the install**, as
 * `telegram_bots.telegram_id` is: the webhook names an account, and one account
 * answering for two brands would make which brand a message belongs to a
 * guess. `external_id` is the phone number id, the Page id or the Instagram
 * account id, the id Meta's envelope carries.
 *
 * **`access_token` is a secret**: the `v1.<keyId>.…` envelope `@helpdock/config`
 * writes under `APP_MASTER_KEY`, never returned to a client after it is saved
 * beyond its last four characters (REQUIREMENTS §5.1). The app's own secrets
 * are install settings (`meta.*`), not columns here.
 *
 * Brand-scoped and not department-scoped: an account is configuration, like a
 * mailbox or a bot.
 */
export const metaAccounts = pgTable(
  'meta_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    platform: metaPlatformEnum('platform').notNull(),
    /** Where a new conversation is filed. Replies stay where their ticket is. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /** The phone number id, the Page id or the Instagram account id. */
    externalId: text('external_id').notNull(),
    /** WhatsApp: the business account the number belongs to; `entry[].id` of its webhooks. */
    wabaId: text('waba_id'),
    /** WhatsApp: the number as Meta displays it. */
    displayPhone: text('display_phone'),
    /** Instagram: the `@handle` without the `@`; Messenger: the Page's name. */
    username: text('username'),
    displayName: text('display_name').notNull(),
    /** Encrypted. */
    accessToken: text('access_token').notNull(),
    tokenKind: metaTokenKindEnum('token_kind').notNull(),
    /** Null for a token that does not expire (a system user's, a Page's). */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    /** Instagram: when `meta.health` last refreshed the token. */
    tokenRefreshedAt: timestamp('token_refreshed_at', { withTimezone: true }),
    tokenUpdatedAt: timestamp('token_updated_at', { withTimezone: true }).notNull(),
    tokenUpdatedBy: uuid('token_updated_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Messenger and Instagram: the operator asserts Meta approved the Human
     * Agent feature for the install's app, which extends a person's reply
     * window to seven days (DOMAIN-RULES §2.6). Never set by Helpdock itself.
     */
    humanAgentEnabled: boolean('human_agent_enabled').notNull().default(false),
    /** The webhook fields the app is subscribed to for this account, as Graph last said. */
    subscribedFields: text('subscribed_fields').array().notNull().default(sql`'{}'::text[]`),
    subscribedAt: timestamp('subscribed_at', { withTimezone: true }),
    subscriptionCheckedAt: timestamp('subscription_checked_at', { withTimezone: true }),
    status: metaAccountStatusEnum('status').notNull().default('connected'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    /** What Graph or the pipeline said the last time it failed. Never the token. */
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('meta_accounts_platform_external_key').on(table.platform, table.externalId),
    index('meta_accounts_brand_idx').on(table.brandId),
  ],
);

export type MetaAccount = typeof metaAccounts.$inferSelect;
export type NewMetaAccount = typeof metaAccounts.$inferInsert;

/**
 * One customer talking to one account (M10-01): `customer_id` is the
 * platform-scoped id Meta sends, `ticket_id` the conversation the next message
 * continues, so a conversation has one open ticket at a time, and
 * `last_inbound_at` the anchor of the reply window (DOMAIN-RULES §2.6).
 *
 * `customer_id` is the WhatsApp business-scoped user id, or the Messenger
 * page-scoped id, or the Instagram-scoped id, as text and only compared.
 *
 * Brand-scoped: it names a ticket but holds none of it, as `telegram_chats`
 * does, and a ticket's own policy decides who may read the ticket.
 */
export const metaConversations = pgTable(
  'meta_conversations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => metaAccounts.id, { onDelete: 'cascade' }),
    customerId: text('customer_id').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    /** WhatsApp: the customer's phone number in digits, when Meta sent it. */
    waId: text('wa_id'),
    /** The name Meta gave, as of the customer's last message. It can change. */
    profileName: text('profile_name'),
    /** Instagram: the customer's `@username` without the `@`. */
    username: text('username'),
    /**
     * Messenger and Instagram: when `meta.profile_fetch` last got an answer from
     * Graph about this customer's name, whatever the answer was. Null until it has,
     * which is what raises the lookup; a refusal (the Page lacks the feature, the
     * customer blocked the account) sets it too, so a refused read is made once
     * per conversation and not on every message.
     */
    profileCheckedAt: timestamp('profile_checked_at', { withTimezone: true }),
    /** The anchor of the reply window. Null until the customer writes. */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastInboundMessageId: text('last_inbound_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('meta_conversations_account_customer_key').on(table.accountId, table.customerId),
    index('meta_conversations_brand_contact_idx').on(table.brandId, table.contactId),
    index('meta_conversations_ticket_idx').on(table.ticketId),
  ],
);

export type MetaConversation = typeof metaConversations.$inferSelect;
export type NewMetaConversation = typeof metaConversations.$inferInsert;

/**
 * One agent reply to deliver to a customer (M10-01), the Meta twin of
 * `telegram_deliveries`: written beside the `meta.reply` outbox row in the
 * reply's transaction, moved along by the `meta.send` job and then by the
 * platform's own delivery and read reports, and the place a failure or a
 * refusal is recorded.
 *
 * **The recipient is frozen at creation** (`customer_id`), so a retry delivers
 * to the customer the reply was written for. **Department-scoped**, as every
 * child of a ticket is.
 */
export const metaDeliveries = pgTable(
  'meta_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    ticketMessageId: uuid('ticket_message_id')
      .notNull()
      .references(() => ticketMessages.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => metaAccounts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => metaConversations.id, { onDelete: 'cascade' }),
    customerId: text('customer_id').notNull(),
    status: metaDeliveryStatusEnum('status').notNull().default('queued'),
    /**
     * How many parts of the reply Meta has accepted. A long reply is several
     * messages and every attachment one more; a retry starts after the last
     * one that landed, so the customer never reads a part twice.
     */
    partsSent: integer('parts_sent').notNull().default(0),
    /** Meta's ids for what was sent (`wamid.…` or `mid`), in order. */
    platformMessageIds: text('platform_message_ids').array().notNull().default(sql`'{}'::text[]`),
    attempts: integer('attempts').notNull().default(0),
    /** Graph's last refusal, truncated. Never the token. */
    lastError: text('last_error'),
    /** Graph's error code for a `failed` or `refused` delivery, as text. */
    errorCode: text('error_code'),
    /** M10-09: `HUMAN_AGENT` when the reply went out in the extended window. */
    tag: text('tag'),
    /** M10-09: the WhatsApp template a reply after the window was sent as. */
    templateName: text('template_name'),
    /** WhatsApp: what Meta billed the message as, from the status report. */
    pricingCategory: text('pricing_category'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('meta_deliveries_message_key').on(table.ticketMessageId),
    index('meta_deliveries_ticket_idx').on(table.ticketId),
    index('meta_deliveries_brand_status_idx').on(table.brandId, table.status),
    // A delivery or read watermark marks every delivery of one conversation
    // sent at or before it (DOMAIN-RULES §4.8).
    index('meta_deliveries_conversation_sent_idx').on(table.conversationId, table.sentAt),
  ],
);

export type MetaDelivery = typeof metaDeliveries.$inferSelect;
export type NewMetaDelivery = typeof metaDeliveries.$inferInsert;

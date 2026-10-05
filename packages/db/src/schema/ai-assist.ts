import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { aiCalls } from './ai.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { articleProposalStatusEnum, localeEnum, ticketPriorityEnum } from './enums.js';
import { hcArticles, hcSections } from './help-center.js';
import { tickets } from './tickets.js';
import { users } from './users.js';

/**
 * Agent assist's "Draft article from ticket" (M7-05): an article the
 * assistant drafted from a closed ticket and an agent sent for approval. A
 * Team Leader approves it into a draft article, which opens in the editor, or
 * rejects it with a reason. Nothing reaches the help center until a person
 * publishes that draft.
 *
 * **Department-scoped**, like the ticket it came from: `department_id` is
 * filled by `helpdock_ticket_child_department`, so a Team Leader reviews the
 * proposals of the departments they lead and no others (DOMAIN-RULES §1.3).
 */
export const articleProposals = pgTable(
  'article_proposals',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /** Where the agent suggested it goes; the reviewer may choose another. */
    sectionId: uuid('section_id').references(() => hcSections.id, { onDelete: 'set null' }),
    locale: localeEnum('locale').notNull(),
    title: text('title').notNull(),
    /** The draft as the agent sent it: the small Markdown subset the assistant writes. */
    bodyMarkdown: text('body_markdown').notNull(),
    /** The agent's note for the reviewer. */
    note: text('note'),
    /** How many of the ticket's messages the draft was written from. */
    messageCount: integer('message_count').notNull().default(0),
    /** The articles the draft cites, as `{ title, articleId }`. */
    citations: jsonb('citations')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id, { onDelete: 'set null' }),
    status: articleProposalStatusEnum('status').notNull().default('waiting'),
    proposedBy: uuid('proposed_by').references(() => users.id, { onDelete: 'set null' }),
    proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    rejectReason: text('reject_reason'),
    /** The draft article an approval created. */
    articleId: uuid('article_id').references(() => hcArticles.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('article_proposals_brand_status_idx').on(table.brandId, table.status, table.proposedAt),
    index('article_proposals_ticket_idx').on(table.ticketId),
    index('article_proposals_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type ArticleProposal = typeof articleProposals.$inferSelect;
export type NewArticleProposal = typeof articleProposals.$inferInsert;

/**
 * The tags, priority and department the assistant suggests for a ticket
 * (M7-05's "Suggest tags, priority, department" and M7-07's AI triage action
 * in `suggest` mode), until an agent accepts or dismisses each. One row per
 * ticket: a new suggestion replaces the last. A field is null once it is
 * accepted or dismissed, or when the assistant had nothing to suggest for it.
 *
 * Department-scoped like the ticket it describes.
 */
export const ticketFieldSuggestions = pgTable(
  'ticket_field_suggestions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /** Existing tags of the brand only: the assistant never invents one. */
    tagIds: uuid('tag_ids').array().notNull().default(sql`'{}'::uuid[]`),
    priority: ticketPriorityEnum('priority'),
    suggestedDepartmentId: uuid('suggested_department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    /** `assist` for an agent's request, `rule:<id>` for a triage action. */
    source: text('source').notNull(),
    aiCallId: uuid('ai_call_id').references(() => aiCalls.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ticket_field_suggestions_ticket_key').on(table.ticketId),
    index('ticket_field_suggestions_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type TicketFieldSuggestion = typeof ticketFieldSuggestions.$inferSelect;
export type NewTicketFieldSuggestion = typeof ticketFieldSuggestions.$inferInsert;

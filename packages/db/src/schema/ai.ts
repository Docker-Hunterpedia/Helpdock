import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { aiBudgetLevelEnum, aiBudgetPeriodEnum, aiCallStatusEnum } from './enums.js';
import { tickets } from './tickets.js';

/**
 * A brand's AI configuration (M7-01, M7-08): which model it uses instead of
 * the install default, its guardrails, its budget and its system prompt.
 *
 * Providers and their credentials are install-wide and live in the
 * `ai.providers` setting, encrypted under `APP_MASTER_KEY`; a brand only names
 * one by id. **No row means the defaults**: the install's model, both
 * guardrails on, no budget and no prompt of its own.
 *
 * Budgets are US dollars, the unit pi-ai prices calls in (ADR 0018). Null is
 * "no limit"; the CHECKs keep a hand-edited row from setting a limit of zero,
 * which would read as a hard stop nobody asked for.
 */
export const aiSettings = pgTable(
  'ai_settings',
  {
    brandId: uuid('brand_id')
      .primaryKey()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** An id from `ai.providers`; null for the install default. Not a key: providers are a setting. */
    providerId: text('provider_id'),
    modelId: text('model_id'),
    systemPrompt: text('system_prompt').notNull().default(''),
    /** The prompt for Arabic conversations (M7-10); empty means the one above serves both. */
    systemPromptAr: text('system_prompt_ar').notNull().default(''),
    /**
     * Agent assist, auto-reply per channel and the handoff wording (M7-10), as
     * `aiAssistantModesSchema` in `@helpdock/schemas` parses it. Null is the
     * defaults: every mode off, so a brand turns AI on deliberately.
     */
    modes: jsonb('modes').$type<Record<string, unknown>>(),
    injectionFilter: boolean('injection_filter').notNull().default(true),
    dailyBudgetUsd: numeric('daily_budget_usd', { precision: 12, scale: 4, mode: 'number' }),
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 12, scale: 4, mode: 'number' }),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'ai_settings_daily_budget_check',
      sql`${table.dailyBudgetUsd} IS NULL OR ${table.dailyBudgetUsd} > 0`,
    ),
    check(
      'ai_settings_monthly_budget_check',
      sql`${table.monthlyBudgetUsd} IS NULL OR ${table.monthlyBudgetUsd} > 0`,
    ),
    check(
      'ai_settings_model_pair_check',
      sql`(${table.providerId} IS NULL) = (${table.modelId} IS NULL)`,
    ),
  ],
);

export type AiSettingsRow = typeof aiSettings.$inferSelect;

/**
 * One call to a model (M7-01): every completion and every embedding request,
 * whichever feature made it, including the ones refused by the budget before
 * they were sent (REQUIREMENTS §4.7: "every AI output is logged").
 *
 * **Brand-scoped, not department-scoped.** A call may have no ticket at all
 * (an embedding, a translation in the composer), and the budget meter sums a
 * brand's calls whatever department they came from. The bodies are read only
 * through a ticket (`GET …/tickets/:ticketId/ai-calls`), and that ticket is
 * read first under its own department policy.
 *
 * **Bodies are what retention takes.** `prompt`, `response`, `redactions` and
 * `sources` are nulled after the brand's AI-log window (DOMAIN-RULES §11) and
 * `bodies_purged_at` says when; the counts and the cost stay for reports and
 * for the budget. The prompt is stored *after* PII redaction, and
 * `redactions` is the placeholder map that lets an agent see the original
 * (M7-08), so it is purged with the rest.
 */
export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    /** Dotted feature name, for example `assist.suggest_reply` or `knowledge.embed`. */
    feature: text('feature').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: aiCallStatusEnum('status').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    redactionCount: integer('redaction_count').notNull().default(0),
    /** SHA-256 of the redacted prompt, kept after the body goes (REQUIREMENTS §4.7). */
    promptHash: text('prompt_hash'),
    prompt: jsonb('prompt').$type<Record<string, unknown>>(),
    response: text('response'),
    redactions: jsonb('redactions').$type<Record<string, unknown>[]>(),
    sources: jsonb('sources').$type<unknown[]>(),
    /** The provider's message on failure, or why the call was refused. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    bodiesPurgedAt: timestamp('bodies_purged_at', { withTimezone: true }),
  },
  (table) => [
    // The budget meter's sum and the retention purge both walk a brand's calls by time.
    index('ai_calls_brand_created_idx').on(table.brandId, table.createdAt),
    index('ai_calls_ticket_idx').on(table.ticketId),
  ],
);

export type AiCall = typeof aiCalls.$inferSelect;
export type NewAiCall = typeof aiCalls.$inferInsert;

/**
 * The budget alerts a brand has had (M7-08), one per window per level. The
 * primary key is what makes the 80 % alert fire once a day rather than once a
 * call: the recorder inserts with `ON CONFLICT DO NOTHING` and writes the
 * `ai.budget_alert` outbox row only when the insert took.
 */
export const aiBudgetAlerts = pgTable(
  'ai_budget_alerts',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    period: aiBudgetPeriodEnum('period').notNull(),
    /** The first day of the window, in UTC: the day itself, or the first of the month. */
    periodStart: date('period_start').notNull(),
    level: aiBudgetLevelEnum('level').notNull(),
    spentUsd: numeric('spent_usd', { precision: 14, scale: 6, mode: 'number' }).notNull(),
    limitUsd: numeric('limit_usd', { precision: 12, scale: 4, mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.brandId, table.period, table.periodStart, table.level] }),
  ],
);

export type AiBudgetAlert = typeof aiBudgetAlerts.$inferSelect;

import { type AiSettingsRow, auditLog, type DbTransaction, tickets } from '@helpdock/db';
import type {
  AiCallView,
  BrandAiCallsPage,
  BrandAiCallsQuery,
  BrandAiModesUpdate,
  BrandAiPromptUpdate,
  BrandAiSettings,
  BrandAiSettingsUpdate,
  TicketAiCalls,
} from '@helpdock/schemas';
import { aiCallViewSchema, parseAiAssistantModes } from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  type AuditCursor,
  decodeAuditCursor,
  encodeAuditCursor,
  InvalidAuditCursorError,
} from '../audit/audit-cursor.js';
import type { AiRepository, AiSettingsValues } from './ai.repository.js';
import type { BudgetMeter } from './budget-meter.js';
import type { InstallAiService } from './install-ai.service.js';

/**
 * A brand's AI assistant settings (M7-01, M7-08) and the AI log of one of its
 * tickets.
 *
 * Two writers, as REQUIREMENTS §4.7 splits them: the system prompt ("tone,
 * language policy, forbidden topics") is the Team Leader's, under
 * `ai:manage`; the model override, the guardrails and the budget — which
 * decide what the brand sends to whom and what it may spend — are the
 * Admin's, under `brand:manage`.
 */

export interface BrandAiContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
}

const valuesOf = (row: AiSettingsRow | undefined): AiSettingsValues => ({
  providerId: row?.providerId ?? null,
  modelId: row?.modelId ?? null,
  piiRedaction: row?.piiRedaction ?? true,
  injectionFilter: row?.injectionFilter ?? true,
  dailyBudgetUsd: row?.dailyBudgetUsd ?? null,
  monthlyBudgetUsd: row?.monthlyBudgetUsd ?? null,
});

export class BrandAiService {
  readonly #repository: AiRepository;
  readonly #budget: BudgetMeter;
  readonly #install: Pick<InstallAiService, 'assertModelAvailable'>;

  constructor(
    repository: AiRepository,
    budget: BudgetMeter,
    install: Pick<InstallAiService, 'assertModelAvailable'>,
  ) {
    this.#repository = repository;
    this.#budget = budget;
    this.#install = install;
  }

  async view(tx: DbTransaction, brandId: string): Promise<BrandAiSettings> {
    const row = await this.#repository.settings(tx, brandId);
    const values = valuesOf(row);
    const reading = await this.#budget.read(tx, brandId);
    const brandSettings = await this.#repository.brandSettings(tx, brandId);
    return {
      providerId: values.providerId,
      modelId: values.modelId,
      systemPrompt: row?.systemPrompt ?? '',
      systemPromptAr: row?.systemPromptAr ?? '',
      piiRedaction: values.piiRedaction,
      injectionFilter: values.injectionFilter,
      budget: { dailyUsd: values.dailyBudgetUsd, monthlyUsd: values.monthlyBudgetUsd },
      modes: parseAiAssistantModes(row?.modes),
      aiCountsAsFirstResponse: brandSettings.aiCountsAsFirstResponse,
      usage: {
        todayUsd: reading.spend.todayUsd,
        monthUsd: reading.spend.monthUsd,
        windows: reading.windows.map(({ period, level, spentUsd, limitUsd }) => ({
          period,
          level,
          spentUsd,
          limitUsd,
        })),
      },
    };
  }

  async update(
    { tx, brandId, actorId }: BrandAiContext,
    body: BrandAiSettingsUpdate,
  ): Promise<BrandAiSettings> {
    if (body.providerId !== null && body.modelId !== null) {
      await this.#install.assertModelAvailable(body.providerId, body.modelId);
    }
    const before = valuesOf(await this.#repository.settings(tx, brandId));
    const after: AiSettingsValues = {
      providerId: body.providerId,
      modelId: body.modelId,
      piiRedaction: body.piiRedaction,
      injectionFilter: body.injectionFilter,
      dailyBudgetUsd: body.budget.dailyUsd,
      monthlyBudgetUsd: body.budget.monthlyUsd,
    };
    await this.#repository.saveSettings(tx, brandId, after, actorId);
    await this.#audit(tx, brandId, actorId, 'ai.settings.updated', { before, after });
    return this.view(tx, brandId);
  }

  async updatePrompt(
    { tx, brandId, actorId }: BrandAiContext,
    body: BrandAiPromptUpdate,
  ): Promise<BrandAiSettings> {
    const row = await this.#repository.settings(tx, brandId);
    const before = { en: row?.systemPrompt ?? '', ar: row?.systemPromptAr ?? '' };
    const after = { en: body.systemPrompt, ar: body.systemPromptAr ?? before.ar };
    await this.#repository.savePrompt(
      tx,
      brandId,
      { systemPrompt: after.en, systemPromptAr: after.ar },
      actorId,
    );
    await this.#audit(tx, brandId, actorId, 'ai.prompt.updated', { before, after });
    return this.view(tx, brandId);
  }

  /**
   * The modes, and `aiCountsAsFirstResponse`, which is kept in
   * `brands.settings` with the SLA settings rather than copied here: two
   * copies of one rule would drift.
   */
  async updateModes(
    { tx, brandId, actorId }: BrandAiContext,
    { aiCountsAsFirstResponse, ...modes }: BrandAiModesUpdate,
  ): Promise<BrandAiSettings> {
    const before = parseAiAssistantModes((await this.#repository.settings(tx, brandId))?.modes);
    const brandSettings = await this.#repository.brandSettings(tx, brandId);
    await this.#repository.saveModes(tx, brandId, modes, actorId);
    if (brandSettings.aiCountsAsFirstResponse !== aiCountsAsFirstResponse) {
      await this.#repository.saveBrandSettings(tx, brandId, {
        ...brandSettings,
        aiCountsAsFirstResponse,
      });
    }
    await this.#audit(tx, brandId, actorId, 'ai.modes.updated', {
      before: { ...before, aiCountsAsFirstResponse: brandSettings.aiCountsAsFirstResponse },
      after: { ...modes, aiCountsAsFirstResponse },
    });
    return this.view(tx, brandId);
  }

  /** The brand's AI activity: counts and cost, never bodies, which stay behind the ticket. */
  async calls(
    tx: DbTransaction,
    brandId: string,
    query: BrandAiCallsQuery,
  ): Promise<BrandAiCallsPage> {
    const rows = await this.#repository.callsOfBrand(tx, brandId, {
      before: cursorOf(query.cursor),
      // One more than a page, to know whether there is another without counting.
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        feature: row.feature,
        model: row.model,
        status: row.status,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        costUsd: row.costUsd,
        createdAt: row.createdAt.toISOString(),
        ticket:
          row.ticketId === null || row.ticketPrefix === null || row.ticketNumber === null
            ? null
            : { id: row.ticketId, reference: `${row.ticketPrefix}-${String(row.ticketNumber)}` },
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeAuditCursor({ at: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  /**
   * The ticket is read first, under the reader's own department policy, so a
   * ticket they cannot open is a 404 here too; only then its calls, which are
   * brand-scoped rows.
   */
  async ticketCalls(tx: DbTransaction, brandId: string, ticketId: string): Promise<TicketAiCalls> {
    const [ticket] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.brandId, brandId)))
      .limit(1);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }

    const rows = await this.#repository.callsOfTicket(tx, brandId, ticketId);
    return {
      items: rows.map(
        (row): AiCallView =>
          aiCallViewSchema.parse({
            id: row.id,
            feature: row.feature,
            provider: row.provider,
            model: row.model,
            status: row.status,
            tokensIn: row.tokensIn,
            tokensOut: row.tokensOut,
            costUsd: row.costUsd,
            latencyMs: row.latencyMs,
            createdAt: row.createdAt.toISOString(),
            prompt: row.prompt,
            response: row.response,
            redactions: row.redactions ?? [],
            sources: row.sources ?? [],
            error: row.error,
            bodiesPurgedAt: row.bodiesPurgedAt?.toISOString() ?? null,
          }),
      ),
    };
  }

  async #audit(
    tx: DbTransaction,
    brandId: string,
    actorId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId,
      action,
      targetType: 'brand',
      targetId: brandId,
      meta,
    });
  }
}

/** The audit log's keyset cursor: the same `(created_at, id)` order. */
const cursorOf = (cursor: string | undefined): AuditCursor | undefined => {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    return decodeAuditCursor(cursor);
  } catch (error) {
    if (error instanceof InvalidAuditCursorError) {
      throw new BadRequestException(error.message);
    }
    /* c8 ignore next 2 -- decoding throws nothing else. */
    throw error;
  }
};

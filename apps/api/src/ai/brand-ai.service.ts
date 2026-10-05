import { type AiSettingsRow, auditLog, type DbTransaction, tickets } from '@helpdock/db';
import type {
  AiCallView,
  BrandAiPromptUpdate,
  BrandAiSettings,
  BrandAiSettingsUpdate,
  TicketAiCalls,
} from '@helpdock/schemas';
import { aiCallViewSchema } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
    return {
      providerId: values.providerId,
      modelId: values.modelId,
      systemPrompt: row?.systemPrompt ?? '',
      piiRedaction: values.piiRedaction,
      injectionFilter: values.injectionFilter,
      budget: { dailyUsd: values.dailyBudgetUsd, monthlyUsd: values.monthlyBudgetUsd },
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
    const before = (await this.#repository.settings(tx, brandId))?.systemPrompt ?? '';
    await this.#repository.savePrompt(tx, brandId, body.systemPrompt, actorId);
    await this.#audit(tx, brandId, actorId, 'ai.prompt.updated', {
      before,
      after: body.systemPrompt,
    });
    return this.view(tx, brandId);
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

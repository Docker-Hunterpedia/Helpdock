import { brands, type DbTransaction } from '@helpdock/db';
import {
  parseBrandSettings,
  REPORT_LIST_ROWS,
  type ReportExport,
  type ReportQuery,
  type ReportSummary,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AiUsageSource } from './ai-usage.js';
import { exportLines } from './report-exports.js';
import { agentSummary, csatSummary, fillDays, openedRate, slaOutcome } from './report-math.js';
import { type ReportScope, ReportsRepository } from './reports.repository.js';

/**
 * Reports (M8-04, REQUIREMENTS §4.8): the summary one screen draws, and the
 * CSV exports. Everything runs in the request's transaction under
 * `report:read`, so the department scope of the reader is row-level
 * security's to apply (DOMAIN-RULES §1.2).
 */
export class ReportsService {
  readonly #repository: ReportsRepository;
  readonly #ai: AiUsageSource;

  constructor(ai: AiUsageSource, repository: ReportsRepository = new ReportsRepository()) {
    this.#ai = ai;
    this.#repository = repository;
  }

  async summary(tx: DbTransaction, brandId: string, query: ReportQuery): Promise<ReportSummary> {
    const brand = await this.#brand(tx, brandId);
    const scope: ReportScope = { brandId, query, timezone: brand.timezone };
    const repository = this.#repository;

    const days = fillDays(query.from, query.to, await repository.byDay(tx, scope));
    const totals = await repository.totals(tx, scope);
    const top = await repository.searches(tx, scope, 'searches', REPORT_LIST_ROWS);
    const zero = await repository.searches(tx, scope, 'zero_results', REPORT_LIST_ROWS);

    return {
      range: { from: query.from, to: query.to, timezone: brand.timezone },
      filters: {
        departmentId: query.departmentId ?? null,
        channel: query.channel ?? null,
        agentId: query.agentId ?? null,
      },
      computedAt: totals.computedAt?.toISOString() ?? null,
      volume: {
        created: days.reduce((sum, day) => sum + day.created, 0),
        resolved: days.reduce((sum, day) => sum + day.resolved, 0),
        byDay: days.map(({ day, created, resolved }) => ({ day, created, resolved })),
        byChannel: (await repository.byChannel(tx, scope)).map(({ key, ...row }) => ({
          channel: key,
          ...row,
        })),
        byPriority: (await repository.byPriority(tx, scope)).map(({ key, ...row }) => ({
          priority: key,
          ...row,
        })),
        byStatus: await repository.byStatus(tx, scope),
        byDayAndChannel: (await repository.byDayAndChannel(tx, scope)).map(
          ({ day, key, created }) => ({ day, channel: key, created }),
        ),
        byDayAndPriority: (await repository.byDayAndPriority(tx, scope)).map(
          ({ day, key, created }) => ({ day, priority: key, created }),
        ),
        byDayAndStatus: (await repository.byDayAndStatus(tx, scope)).map(
          ({ day, key, created }) => ({ day, statusId: key, tickets: created }),
        ),
      },
      firstResponse: await repository.durations(tx, scope, 'first_response_ms'),
      resolution: await repository.durations(tx, scope, 'resolution_ms'),
      sla: {
        response: slaOutcome(totals.slaResponseMet, totals.slaResponseBreached),
        resolution: slaOutcome(totals.slaResolutionMet, totals.slaResolutionBreached),
        byPriority: (await repository.slaByPriority(tx, scope)).map((row) => ({
          priority: row.priority,
          ...slaOutcome(row.met, row.breached),
        })),
        countsReopens: brand.countsReopens,
      },
      backlog: days.map(({ day, backlog }) => ({ day, open: backlog })),
      csat: csatSummary(totals.csat),
      agents: (await repository.agents(tx, scope, REPORT_LIST_ROWS)).map(agentSummary),
      unassignedOpen: await repository.unassignedOpen(tx, scope),
      agentChoices: await repository.agentChoices(tx, scope),
      busiestHours: await repository.busiestHours(tx, scope),
      searches: {
        top: top.map((row) => ({
          query: row.query,
          locale: row.locale,
          searches: row.searches,
          openedRate: openedRate(row.opened, row.searches),
        })),
        zeroResult: zero.map((row) => ({
          query: row.query,
          locale: row.locale,
          searches: row.zeroResults,
        })),
      },
      ai: await this.#ai.report(tx, {
        brandId,
        from: query.from,
        to: query.to,
        timezone: brand.timezone,
        departmentId: query.departmentId,
      }),
    };
  }

  /**
   * One report as CSV lines, header first. The rows are read here, inside the
   * request's transaction, and the controller streams the lines out after it
   * has closed: a stream that read from the database as it went would run
   * outside the tenant transaction that makes the read safe.
   */
  async export(
    tx: DbTransaction,
    brandId: string,
    report: ReportExport,
    query: ReportQuery,
  ): Promise<readonly string[]> {
    const brand = await this.#brand(tx, brandId);

    return exportLines(report, {
      tx,
      scope: { brandId, query, timezone: brand.timezone },
      repository: this.#repository,
    });
  }

  async #brand(
    tx: DbTransaction,
    brandId: string,
  ): Promise<{ timezone: string; countsReopens: boolean }> {
    const [row] = await tx
      .select({ timezone: brands.timezone, settings: brands.settings })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    /* c8 ignore next 3 -- the permission guard has already found the brand. */
    if (row === undefined) {
      throw new NotFoundException('No such brand');
    }

    return {
      timezone: row.timezone,
      countsReopens: parseBrandSettings(row.settings).slaCountReopens,
    };
  }
}

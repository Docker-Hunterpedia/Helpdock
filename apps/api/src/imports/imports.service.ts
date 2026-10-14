import { encryptSecret, type Keyring } from '@helpdock/config';
import { auditLog, importRuns } from '@helpdock/db';
import type { Connector, ConnectorContext, ZendeskCredentials } from '@helpdock/importers';
import {
  type ImportConnectionRequest,
  type ImportRunCreate,
  type ImportScope,
  importConnectionRequestSchema,
  importConnectionResultSchema,
  importRunCreateSchema,
  importRunListSchema,
  importScopeSchema,
} from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { enqueueImportWork } from './import-events.js';
import { importRunView } from './import-run-view.js';
import { lockImportBrand } from './jobs/claims.js';
import { cancelImportRun, pauseImportRun, resumeImportRun } from './jobs/run-control.js';
import { bindImportSourceAccount } from './jobs/source-account.js';
import { ImportLoadError } from './loader/contracts.js';

export type ImportConnectionFactory = (request: ImportConnectionRequest) => {
  connector: Connector<ZendeskCredentials>;
  context: ConnectorContext<ZendeskCredentials>;
};

export class ImportsService {
  constructor(
    readonly keyring: Keyring,
    readonly connection: ImportConnectionFactory,
  ) {}

  async get({ tx, brandId }: TicketingContext, runId: string) {
    const [run] = await tx
      .select()
      .from(importRuns)
      .where(and(eq(importRuns.brandId, brandId), eq(importRuns.id, runId)));
    if (!run) throw new NotFoundException('import.run-not-found');
    return importRunView(run);
  }
  async list({ tx, brandId }: TicketingContext) {
    const runs = await tx
      .select()
      .from(importRuns)
      .where(eq(importRuns.brandId, brandId))
      .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
      .limit(100);
    return importRunListSchema.parse({ runs: runs.map(importRunView) });
  }
  async create(context: TicketingContext, raw: ImportRunCreate) {
    const input = importRunCreateSchema.parse(raw);
    if (input.source !== 'zendesk') throw new BadRequestException('import.source-unavailable');
    if (input.parentRunId) {
      const parent = await this.get(context, input.parentRunId);
      if (parent.status !== 'completed' || parent.source !== input.source)
        throw new ConflictException('import.parent-invalid');
    }
    const [run] = await context.tx
      .insert(importRuns)
      .values({
        brandId: context.brandId,
        startedBy: context.actor.userId,
        source: input.source,
        mode: input.mode,
        parentRunId: input.parentRunId ?? null,
      })
      .returning();
    if (!run) throw new Error('import.create-failed');
    await this.audit(context, 'import.created', run.id);
    return importRunView(run);
  }
  async connect(context: TicketingContext, runId: string, raw: ImportConnectionRequest) {
    const input = importConnectionRequestSchema.parse(raw);
    await lockImportBrand(context.tx, context.brandId);
    const run = await this.get(context, runId);
    if (run.source !== 'zendesk') throw new BadRequestException('import.source-unavailable');
    if (!['draft', 'connecting'].includes(run.status))
      throw new ConflictException('import.phase-invalid');
    const runtime = this.connection(input);
    const tested = await runtime.connector.test(runtime.context);
    if (!tested.ok) throw new BadRequestException(`import.${tested.reason}`);
    try {
      await bindImportSourceAccount(context.tx, {
        brandId: context.brandId,
        runId,
        verifiedAccount: tested.account,
      });
    } catch (error) {
      if (error instanceof ImportLoadError && error.code === 'mapping-invalid')
        throw new ConflictException('import.account-mismatch');
      throw error;
    }
    await context.tx
      .update(importRuns)
      .set({
        status: 'connecting',
        credentialsEncrypted: encryptSecret(JSON.stringify(input.credentials), this.keyring),
        options: sql`${importRuns.options} || ${JSON.stringify({ downloadHosts: input.downloadHosts })}::jsonb`,
      })
      .where(and(eq(importRuns.brandId, context.brandId), eq(importRuns.id, runId)));
    await this.audit(context, 'import.connected', runId);
    return importConnectionResultSchema.parse({
      run: await this.get(context, runId),
      account: tested.account,
    });
  }
  async extract(context: TicketingContext, runId: string) {
    await lockImportBrand(context.tx, context.brandId);
    const run = await this.get(context, runId);
    if (run.status !== 'connecting' || !run.hasCredentials)
      throw new ConflictException('import.phase-invalid');
    await context.tx
      .update(importRuns)
      .set({ status: 'extracting', startedAt: new Date() })
      .where(and(eq(importRuns.brandId, context.brandId), eq(importRuns.id, runId)));
    await enqueueImportWork(context.tx, { brandId: context.brandId, runId, step: 'extract' });
    await this.audit(context, 'import.started', runId);
    return this.get(context, runId);
  }
  async scope(context: TicketingContext, runId: string, raw: ImportScope) {
    const scope = importScopeSchema.parse(raw);
    await lockImportBrand(context.tx, context.brandId);
    const run = await this.get(context, runId);
    if (!['draft', 'connecting'].includes(run.status))
      throw new ConflictException('import.phase-invalid');
    await context.tx
      .update(importRuns)
      .set({
        options: sql`${importRuns.options} || ${JSON.stringify(scope)}::jsonb`,
        dryRunReport: null,
      })
      .where(and(eq(importRuns.brandId, context.brandId), eq(importRuns.id, runId)));
    await this.audit(context, 'import.scope-updated', runId);
    return this.get(context, runId);
  }
  async control(context: TicketingContext, runId: string, action: 'pause' | 'resume' | 'cancel') {
    await this.get(context, runId);
    const scope = { brandId: context.brandId, runId };
    if (action === 'resume') {
      const phase = await resumeImportRun(context.tx, scope);
      if (!phase) throw new ConflictException('import.phase-invalid');
      if (phase === 'dry_run') throw new ConflictException('import.phase-unavailable');
      await enqueueImportWork(context.tx, {
        ...scope,
        step: phase === 'extracting' ? 'extract' : phase === 'finishing' ? 'finish' : 'load',
      });
    } else {
      const changed = await (action === 'pause'
        ? pauseImportRun(context.tx, scope)
        : cancelImportRun(context.tx, scope));
      if (!changed) throw new ConflictException('import.phase-invalid');
    }
    await this.audit(
      context,
      action === 'pause'
        ? 'import.paused'
        : action === 'resume'
          ? 'import.resumed'
          : 'import.cancelled',
      runId,
    );
    return this.get(context, runId);
  }
  private async audit({ tx, brandId, actor }: TicketingContext, action: string, runId: string) {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action,
      targetType: 'import_run',
      targetId: runId,
      meta: {},
    });
  }
}

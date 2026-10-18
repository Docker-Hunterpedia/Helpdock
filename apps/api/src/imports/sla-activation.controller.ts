import { auditLog, uuidv7 } from '@helpdock/db';
import {
  importRunParamSchema,
  importSlaOverviewSchema,
  importSlaStartRequestSchema,
} from '@helpdock/schemas';
import { Body, ConflictException, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import { lockImportBrand } from './jobs/claims.js';
import {
  activationAvailable,
  activationRun,
  activationState,
  importedSlaOverview,
  storeActivation,
} from './sla-activation.js';
import { enqueueSlaActivation } from './sla-activation-events.js';

class RunParamDto extends createZodDto(importRunParamSchema) {}
class OverviewDto extends createZodDto(importSlaOverviewSchema) {}
class StartDto extends createZodDto(importSlaStartRequestSchema) {}

@Controller('api/brands/:brandId/imports/:runId/sla')
export class ImportSlaActivationController {
  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(OverviewDto)
  overview(@Param(new ZodValidationPipe(RunParamDto)) scope: RunParamDto) {
    return importedSlaOverview(requireTicketingContext().tx, scope);
  }

  @Post('start')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(OverviewDto)
  async start(
    @Param(new ZodValidationPipe(RunParamDto)) scope: RunParamDto,
    @Body(new ZodValidationPipe(StartDto)) _body: StartDto,
  ) {
    const { tx, actor } = requireTicketingContext();
    await lockImportBrand(tx, scope.brandId);
    const run = await activationRun(tx, scope);
    const now = new Date();
    if (!activationAvailable(run)) throw new ConflictException('import.sla-activation-unavailable');
    const previous = activationState(run);
    if (previous && ['queued', 'running'].includes(previous.status))
      return importedSlaOverview(tx, scope, now);
    const overview = await importedSlaOverview(tx, scope, now);
    if (!overview.eligible && previous?.status !== 'failed') return overview;
    const state = {
      ...(previous?.status === 'failed'
        ? previous
        : { after: null, checked: 0, started: 0, skipped: 0, requestedAt: now.toISOString() }),
      revision: uuidv7(),
      requestedBy: actor.userId,
      status: 'queued' as const,
      updatedAt: now.toISOString(),
    };
    await storeActivation(tx, run, state);
    await enqueueSlaActivation(tx, { ...scope, revision: state.revision, after: state.after });
    await tx.insert(auditLog).values({
      brandId: scope.brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action: 'import.sla-activation-requested',
      targetType: 'import_run',
      targetId: scope.runId,
      meta: { eligible: overview.eligible, resumed: previous?.status === 'failed' },
    });
    return importedSlaOverview(tx, scope, now);
  }
}

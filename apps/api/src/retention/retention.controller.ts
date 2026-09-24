import type { RetentionOverview } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { RetentionBrandParamDto, RetentionOverviewDto, RetentionUpdateRequestDto } from './dto.js';
import { RetentionService } from './retention.service.js';

/**
 * The Data retention card of `Admin/Brand · Danger zone` (M1-14).
 *
 * Both routes are `brand:manage`, which only an Admin holds: DOMAIN-RULES §11
 * says the windows are "set by Admin", and even reading them is Admin-only
 * because the screen that reads them is.
 *
 * `PUT` rather than `PATCH`: the body is the whole form, for the reason
 * `retentionUpdateRequestSchema` gives.
 */
@Controller('api/brands/:brandId/retention')
export class RetentionController {
  readonly #retention: RetentionService;

  constructor(@Inject(RetentionService) retention: RetentionService) {
    this.#retention = retention;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(RetentionOverviewDto)
  overview(
    @Param(new ZodValidationPipe(RetentionBrandParamDto)) { brandId }: RetentionBrandParamDto,
  ): Promise<RetentionOverview> {
    return this.#retention.overview(getTx(), brandId);
  }

  @Put()
  @Requires('brand:manage')
  @ZodSerializerDto(RetentionOverviewDto)
  update(
    @Param(new ZodValidationPipe(RetentionBrandParamDto)) { brandId }: RetentionBrandParamDto,
    @Body(new ZodValidationPipe(RetentionUpdateRequestDto)) body: RetentionUpdateRequestDto,
  ): Promise<RetentionOverview> {
    return this.#retention.update(
      {
        tx: getTx(),
        brandId,
        actorId: requireStaffPrincipalId(requireRequestContext().principal),
      },
      body,
    );
  }
}

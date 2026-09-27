import {
  brandIdParamSchema,
  type HcInsights,
  hcInsightsQuerySchema,
  hcInsightsSchema,
} from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../../auth/route-declaration.js';
import { getTx } from '../../context/request-context.js';
import { HelpCenterInsightsService } from './insights.service.js';

class InsightsParamDto extends createZodDto(brandIdParamSchema) {}
class InsightsQueryDto extends createZodDto(hcInsightsQuerySchema) {}
class InsightsDto extends createZodDto(hcInsightsSchema) {}

/** Help center › Insights (M5-08). Every role holds `help_center:read`; the tab shows it to all but Agents. */
@Controller('api/brands/:brandId/help-center')
export class HelpCenterInsightsController {
  readonly #insights: HelpCenterInsightsService;

  constructor(@Inject(HelpCenterInsightsService) insights: HelpCenterInsightsService) {
    this.#insights = insights;
  }

  @Get('insights')
  @Requires('help_center:read')
  @ZodSerializerDto(InsightsDto)
  insights(
    @Param(new ZodValidationPipe(InsightsParamDto)) { brandId }: InsightsParamDto,
    @Query(new ZodValidationPipe(InsightsQueryDto)) query: InsightsQueryDto,
  ): Promise<HcInsights> {
    return this.#insights.insights(getTx(), brandId, query);
  }
}

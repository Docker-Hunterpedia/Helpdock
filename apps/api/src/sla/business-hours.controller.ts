import type { BusinessHoursOverview, Holiday } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { BusinessHoursService } from './business-hours.service.js';
import {
  BusinessHoursOverviewDto,
  BusinessHoursUpdateRequestDto,
  HolidayCreateRequestDto,
  HolidayDto,
  HolidayParamDto,
  SlaBrandParamDto,
} from './dto.js';
import { slaAdminContext } from './sla-admin-context.js';

/**
 * The Business hours tab of `Admin/Ticketing` (M3-01, artboard
 * `Admin/Ticketing-BusinessHours`).
 *
 * `ticketing:manage`, which an Admin and a Team Leader hold: DOMAIN-RULES §1.2
 * gives a Team Leader the SLAs of the departments they lead. What each may
 * touch inside the tab — the brand's own hours and zone are the Admin's — is
 * `sla-scope.ts`'s to decide.
 */
@Controller('api/brands/:brandId')
export class BusinessHoursController {
  readonly #hours: BusinessHoursService;

  constructor(@Inject(BusinessHoursService) hours: BusinessHoursService) {
    this.#hours = hours;
  }

  @Get('business-hours')
  @Requires('ticketing:manage')
  @ZodSerializerDto(BusinessHoursOverviewDto)
  overview(
    @Param(new ZodValidationPipe(SlaBrandParamDto)) { brandId }: SlaBrandParamDto,
  ): Promise<BusinessHoursOverview> {
    return this.#hours.overview(getTx(), brandId);
  }

  @Put('business-hours')
  @Requires('ticketing:manage')
  @ZodSerializerDto(BusinessHoursOverviewDto)
  update(
    @Param(new ZodValidationPipe(SlaBrandParamDto)) _params: SlaBrandParamDto,
    @Body(new ZodValidationPipe(BusinessHoursUpdateRequestDto)) body: BusinessHoursUpdateRequestDto,
  ): Promise<BusinessHoursOverview> {
    return this.#hours.update(slaAdminContext(), body);
  }

  @Post('holidays')
  @Requires('ticketing:manage')
  @ZodSerializerDto(HolidayDto)
  createHoliday(
    @Param(new ZodValidationPipe(SlaBrandParamDto)) _params: SlaBrandParamDto,
    @Body(new ZodValidationPipe(HolidayCreateRequestDto)) body: HolidayCreateRequestDto,
  ): Promise<Holiday> {
    return this.#hours.createHoliday(slaAdminContext(), body);
  }

  @Delete('holidays/:holidayId')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteHoliday(
    @Param(new ZodValidationPipe(HolidayParamDto)) { holidayId }: HolidayParamDto,
  ): Promise<void> {
    await this.#hours.deleteHoliday(slaAdminContext(), holidayId);
  }
}

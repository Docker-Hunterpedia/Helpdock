import type { SnoozePresets } from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../../auth/route-declaration.js';
import { SnoozePresetsDto, SnoozePresetsQueryDto, TicketParamDto } from '../dto.js';
import { SnoozeService } from './snooze.service.js';

/** M14-02: the Snooze menu's presets. Reading them writes nothing, so `ticket:read`. */
@Controller('api/brands/:brandId')
export class SnoozeController {
  readonly #snooze: SnoozeService;

  constructor(@Inject(SnoozeService) snooze: SnoozeService) {
    this.#snooze = snooze;
  }

  @Get('tickets/:ticketId/snooze-presets')
  @Requires('ticket:read')
  @ZodSerializerDto(SnoozePresetsDto)
  async presets(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
    @Query(new ZodValidationPipe(SnoozePresetsQueryDto)) { timeZone }: SnoozePresetsQueryDto,
  ): Promise<SnoozePresets> {
    return this.#snooze.presets(brandId, ticketId, timeZone);
  }
}

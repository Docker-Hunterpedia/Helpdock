import type { TicketRouting } from '@helpdock/schemas';
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../../auth/route-declaration.js';
import { TicketParamDto, TicketRoutingDto } from '../dto.js';
import { TicketRoutingService } from './ticket-routing.service.js';

/** M14-08: "How it got here", for the ticket details panel. */
@Controller('api/brands/:brandId')
export class TicketRoutingController {
  readonly #routing: TicketRoutingService;

  constructor(@Inject(TicketRoutingService) routing: TicketRoutingService) {
    this.#routing = routing;
  }

  @Get('tickets/:ticketId/routing')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketRoutingDto)
  async trail(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
  ): Promise<TicketRouting> {
    return this.#routing.trail(brandId, ticketId);
  }
}

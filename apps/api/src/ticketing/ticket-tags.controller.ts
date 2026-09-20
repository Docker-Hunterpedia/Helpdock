import type { TicketTagList } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { Principal } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { TicketTagListDto, TicketTagParamDto, TicketTagsRequestDto } from './dto.js';
import { TicketTagsService } from './ticket-tags.service.js';

/**
 * The tags on one ticket.
 *
 * `PUT`, because the body is the whole set the ticket should carry afterwards
 * and sending it twice has to mean what sending it once meant. `ticket:write`,
 * not `ticketing:manage`: tagging is working a ticket, which every Agent does,
 * while deciding what tags exist is configuration.
 *
 * It sits in the ticketing module rather than beside the ticket routes because
 * everything it touches — `tags`, `ticket_tags`, the replace — is M1-06's, and
 * `app.module.ts` gains one import either way.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/tags')
export class TicketTagsController {
  readonly #tags: TicketTagsService;

  constructor(@Inject(TicketTagsService) tags: TicketTagsService) {
    this.#tags = tags;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(TicketTagListDto)
  list(
    @Param(new ZodValidationPipe(TicketTagParamDto)) { ticketId }: TicketTagParamDto,
  ): Promise<TicketTagList> {
    return this.#tags.list(getTx(), ticketId);
  }

  @Put()
  @Requires('ticket:write')
  @ZodSerializerDto(TicketTagListDto)
  replace(
    @Param(new ZodValidationPipe(TicketTagParamDto)) { brandId, ticketId }: TicketTagParamDto,
    @Body(new ZodValidationPipe(TicketTagsRequestDto)) body: TicketTagsRequestDto,
  ): Promise<TicketTagList> {
    return this.#tags.replace(getTx(), brandId, this.#principal(), ticketId, body);
  }

  #principal(): Principal {
    const principal = requireRequestContext().principal;
    /* c8 ignore next 3 -- the guard refuses the request before a handler runs. */
    if (principal === null) {
      throw new Error('The authentication guard let an unauthenticated request through');
    }

    return principal;
  }
}

import type { TimeEntryList } from '@helpdock/schemas';
import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { Principal } from '../../auth/principal.js';
import { Requires } from '../../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../../context/request-context.js';
import { TicketParamDto } from '../dto.js';
import { TimeEntryCreateRequestDto, TimeEntryListDto, TimeEntryParamDto } from './dto.js';
import { TimeEntriesService } from './time-entries.service.js';

/**
 * The Time card of the ticket's details panel and the Log time dialog
 * (`AdminTicketDialogs`, panels 6 and 8; M1-12).
 *
 * Every write answers with the whole list and its total, which is what the card
 * redraws from, so a client never has to add a row to a sum it did not compute.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/time-entries')
export class TimeEntriesController {
  readonly #entries: TimeEntriesService;

  constructor(@Inject(TimeEntriesService) entries: TimeEntriesService) {
    this.#entries = entries;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(TimeEntryListDto)
  list(
    @Param(new ZodValidationPipe(TicketParamDto)) { ticketId }: TicketParamDto,
  ): Promise<TimeEntryList> {
    return this.#entries.list(getTx(), ticketId);
  }

  @Post()
  @Requires('ticket:write')
  @ZodSerializerDto(TimeEntryListDto)
  create(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
    @Body(new ZodValidationPipe(TimeEntryCreateRequestDto)) body: TimeEntryCreateRequestDto,
  ): Promise<TimeEntryList> {
    return this.#entries.create(getTx(), brandId, this.#principal(), ticketId, body);
  }

  @Delete(':entryId')
  @Requires('ticket:write')
  @ZodSerializerDto(TimeEntryListDto)
  remove(
    @Param(new ZodValidationPipe(TimeEntryParamDto)) {
      brandId,
      ticketId,
      entryId,
    }: TimeEntryParamDto,
  ): Promise<TimeEntryList> {
    return this.#entries.remove(getTx(), brandId, this.#principal(), ticketId, entryId);
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

import type { TicketParticipantList } from '@helpdock/schemas';
import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  TicketCcRequestDto,
  TicketParamDto,
  TicketParticipantListDto,
  TicketParticipantParamDto,
} from './dto.js';
import {
  type ParticipantContext,
  TicketParticipantsService,
} from './ticket-participants.service.js';

/**
 * The participants of one ticket (DOMAIN-RULES §2.5, M1-13). Reading them is
 * reading the ticket; adding and removing a CC is working it, so `ticket:write`
 * as for a tag. Which tickets this reaches is not decided here: the ticket read
 * and the `ticket_participants` trigger both run under the caller's own
 * policies, so a ticket in another department is a 404.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/participants')
export class ParticipantsController {
  readonly #participants: TicketParticipantsService;

  constructor(@Inject(TicketParticipantsService) participants: TicketParticipantsService) {
    this.#participants = participants;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(TicketParticipantListDto)
  list(
    @Param(new ZodValidationPipe(TicketParamDto)) { ticketId }: TicketParamDto,
  ): Promise<TicketParticipantList> {
    return this.#participants.list(getTx(), ticketId);
  }

  @Post()
  @Requires('ticket:write')
  @ZodSerializerDto(TicketParticipantListDto)
  addCc(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
    @Body(new ZodValidationPipe(TicketCcRequestDto)) body: TicketCcRequestDto,
  ): Promise<TicketParticipantList> {
    return this.#participants.addCc(context(brandId), ticketId, body);
  }

  @Delete(':participantId')
  @Requires('ticket:write')
  @ZodSerializerDto(TicketParticipantListDto)
  removeCc(
    @Param(new ZodValidationPipe(TicketParticipantParamDto))
    { brandId, ticketId, participantId }: TicketParticipantParamDto,
  ): Promise<TicketParticipantList> {
    return this.#participants.removeCc(context(brandId), ticketId, participantId);
  }
}

const context = (brandId: string): ParticipantContext => {
  const principal = requireRequestContext().principal;
  /* c8 ignore next 3 -- the guard refuses the request before a handler runs. */
  if (principal === null) {
    throw new Error('The authentication guard let an unauthenticated request through');
  }

  return { tx: getTx(), brandId, principal };
};

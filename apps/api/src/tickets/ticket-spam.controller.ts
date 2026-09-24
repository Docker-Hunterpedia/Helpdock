import type { Ticket, TicketSpamSender } from '@helpdock/schemas';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { Principal } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import {
  MarkSpamRequestDto,
  SpamTicketDto,
  SpamTicketParamDto,
  TicketSpamSenderDto,
} from '../ticketing/dto.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import { TicketSpamService } from './ticket-spam.service.js';

/**
 * "Mark as spam" and "Not spam" (M1-11), as a resource of the ticket: `POST`
 * puts the ticket in Spam, `DELETE` takes it out. Both answer the ticket as it
 * now is, so the workspace redraws from the response rather than a second read.
 *
 * `ticket:write`, the permission §2.2 gives the agent who "ticks 'block
 * sender'"; reading what the dialog will offer is `ticket:read`.
 */
@Controller('api/brands/:brandId/tickets/:ticketId')
export class TicketSpamController {
  readonly #spam: TicketSpamService;

  constructor(@Inject(TicketSpamService) spam: TicketSpamService) {
    this.#spam = spam;
  }

  @Get('spam-sender')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketSpamSenderDto)
  sender(
    @Param(new ZodValidationPipe(SpamTicketParamDto)) { brandId, ticketId }: SpamTicketParamDto,
  ): Promise<TicketSpamSender> {
    return this.#spam.sender(brandId, ticketId);
  }

  @Post('spam')
  @Requires('ticket:write')
  @ZodSerializerDto(SpamTicketDto)
  mark(
    @Param(new ZodValidationPipe(SpamTicketParamDto)) { brandId, ticketId }: SpamTicketParamDto,
    @Body(new ZodValidationPipe(MarkSpamRequestDto)) body: MarkSpamRequestDto,
  ): Promise<Ticket> {
    const principal = this.#principal();
    if (!body.blockSender) {
      return this.#spam.mark(brandId, principal, ticketId, null);
    }
    // A block-list row names who added it, so only a person may ask for one;
    // an api key may still mark a ticket as spam.
    if (principal.type !== 'staff') {
      throw new BadRequestException('Only a staff member can block a sender');
    }

    return this.#spam.mark(brandId, principal, ticketId, requireTicketingContext());
  }

  @Delete('spam')
  @Requires('ticket:write')
  @ZodSerializerDto(SpamTicketDto)
  unmark(
    @Param(new ZodValidationPipe(SpamTicketParamDto)) { brandId, ticketId }: SpamTicketParamDto,
  ): Promise<Ticket> {
    return this.#spam.unmark(brandId, this.#principal(), ticketId);
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

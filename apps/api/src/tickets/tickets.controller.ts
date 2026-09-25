import type {
  Ticket,
  TicketActivityList,
  TicketDetail,
  TicketList,
  TicketMessage,
  TicketMessagePage,
  TicketStatusList,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { principalHasPermission } from '../auth/permissions.js';
import { type Principal, principalIdOf } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import {
  MessageCreateRequestDto,
  MessagePageQueryDto,
  TicketActivityListDto,
  TicketBrandParamDto,
  TicketCreateRequestDto,
  TicketDetailDto,
  TicketDto,
  TicketListDto,
  TicketListQueryDto,
  TicketMessageDto,
  TicketMessagePageDto,
  TicketParamDto,
  TicketStatusListDto,
  TicketUpdateRequestDto,
} from './dto.js';
import { TicketsService } from './tickets.service.js';

/**
 * M1-02 and M1-03 over HTTP.
 *
 * Every route is `@Requires('ticket:read')` or `@Requires('ticket:write')`,
 * which is layer 1 of DOMAIN-RULES §1.3 and is what decides *which brand* the
 * request's transaction names. Which **department** it reaches is layer 3's,
 * and it is not repeated here: an Agent asking for a ticket in another
 * department gets a 404 from the policy, by list, by id and by message cursor
 * alike.
 *
 * There are no screens for any of this yet. The ticket view is M1-15, built
 * from the `Admin · ticket view` artboard; what M1-15 needs is a stable
 * contract, which is what this is.
 */
@Controller('api/brands/:brandId')
export class TicketsController {
  readonly #tickets: TicketsService;

  constructor(@Inject(TicketsService) tickets: TicketsService) {
    this.#tickets = tickets;
  }

  /** The status picker's options, and what a badge is drawn from (DOMAIN-RULES §2.1). */
  @Get('ticket-statuses')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketStatusListDto)
  async statuses(
    @Param(new ZodValidationPipe(TicketBrandParamDto)) _params: TicketBrandParamDto,
  ): Promise<TicketStatusList> {
    return this.#tickets.statuses();
  }

  @Get('tickets')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketListDto)
  async list(
    @Param(new ZodValidationPipe(TicketBrandParamDto)) { brandId }: TicketBrandParamDto,
    @Query(new ZodValidationPipe(TicketListQueryDto)) query: TicketListQueryDto,
  ): Promise<TicketList> {
    return this.#tickets.list({ brandId, viewerId: principalIdOf(this.#principal()) }, query, {
      withContacts: this.#readsContacts(brandId),
    });
  }

  @Post('tickets')
  @Requires('ticket:write')
  @ZodSerializerDto(TicketDetailDto)
  async create(
    @Param(new ZodValidationPipe(TicketBrandParamDto)) { brandId }: TicketBrandParamDto,
    @Body(new ZodValidationPipe(TicketCreateRequestDto)) body: TicketCreateRequestDto,
  ): Promise<TicketDetail> {
    return this.#tickets.create(brandId, this.#principal(), body);
  }

  @Get('tickets/:ticketId')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketDetailDto)
  async find(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
  ): Promise<TicketDetail> {
    return this.#tickets.find(ticketId, { withContacts: this.#readsContacts(brandId) });
  }

  @Patch('tickets/:ticketId')
  @Requires('ticket:write')
  @ZodSerializerDto(TicketDto)
  async update(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
    @Body(new ZodValidationPipe(TicketUpdateRequestDto)) body: TicketUpdateRequestDto,
  ): Promise<Ticket> {
    return this.#tickets.update(brandId, this.#principal(), ticketId, body);
  }

  /**
   * The catch-up read of DOMAIN-RULES §7: everything after the `seq` the client
   * holds. A reconnecting client calls this rather than reloading the thread.
   */
  @Get('tickets/:ticketId/messages')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketMessagePageDto)
  async messages(
    @Param(new ZodValidationPipe(TicketParamDto)) { ticketId }: TicketParamDto,
    @Query(new ZodValidationPipe(MessagePageQueryDto)) query: MessagePageQueryDto,
  ): Promise<TicketMessagePage> {
    return this.#tickets.messages(ticketId, query);
  }

  /**
   * A public reply or an internal note. The response carries the `seq`, which
   * is what makes the message "sent" for the client (§7); until it holds one
   * the composer shows "sending".
   */
  @Post('tickets/:ticketId/messages')
  @Requires('ticket:write')
  @ZodSerializerDto(TicketMessageDto)
  async reply(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
    @Body(new ZodValidationPipe(MessageCreateRequestDto)) body: MessageCreateRequestDto,
  ): Promise<TicketMessage> {
    return this.#tickets.addMessage(brandId, this.#principal(), ticketId, body);
  }

  /**
   * DOMAIN-RULES §2.2's last row: "Soft-deleted by Admin — hidden from all
   * views; purged by retention (§11)."
   *
   * `brand:manage`, which only an Admin holds: `ticket:write` is every agent's,
   * and hiding a ticket from the whole brand is not an edit. The ticket keeps
   * its status and its thread, and answers 404 from here on — the same answer a
   * ticket in another department gives, for the same reason.
   */
  @Delete('tickets/:ticketId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
  ): Promise<void> {
    await this.#tickets.remove(brandId, this.#principal(), ticketId);
  }

  @Get('tickets/:ticketId/activity')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketActivityListDto)
  async activity(
    @Param(new ZodValidationPipe(TicketParamDto)) { ticketId }: TicketParamDto,
  ): Promise<TicketActivityList> {
    return this.#tickets.activity(ticketId);
  }

  /**
   * Whether the embedded contact name may be filled in (M1-15). The route
   * asks for `ticket:read`; the name is a contact's, so it follows
   * `contact:read` on top.
   */
  #readsContacts(brandId: string): boolean {
    return principalHasPermission(this.#principal(), brandId, 'contact:read');
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

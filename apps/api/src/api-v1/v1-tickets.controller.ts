import type {
  Ticket,
  TicketDetail,
  TicketList,
  TicketMessage,
  TicketMessagePage,
  V1TicketDetail,
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
  UseInterceptors,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { apiKeyPrincipal, keyHolds } from './api-key-context.js';
import {
  V1MessageCreateRequestDto,
  V1MessagePageQueryDto,
  V1TicketCreateRequestDto,
  V1TicketDetailDto,
  V1TicketDto,
  V1TicketListDto,
  V1TicketListQueryDto,
  V1TicketMessageDto,
  V1TicketMessagePageDto,
  V1TicketParamDto,
  V1TicketUpdateRequestDto,
} from './dto.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * M8-02: tickets and their messages over the public API. Every route goes
 * through `TicketsService`, the admin's own, so a ticket filed here gets the
 * same transitions, SLA clocks, routing and outbox events as one typed into the
 * desk — and so the same webhooks.
 *
 * The brand is the key's; the key reaches every department of it.
 */
@Controller('api/v1/tickets')
export class V1TicketsController {
  readonly #tickets: TicketsService;

  constructor(@Inject(TicketsService) tickets: TicketsService) {
    this.#tickets = tickets;
  }

  @Get()
  @Requires('tickets:read')
  @ZodSerializerDto(V1TicketListDto)
  list(
    @Query(new ZodValidationPipe(V1TicketListQueryDto)) query: V1TicketListQueryDto,
  ): Promise<TicketList> {
    const key = apiKeyPrincipal();
    return this.#tickets.list({ brandId: key.brandId, viewerId: key.id }, query, {
      withContacts: keyHolds('contacts:read'),
    });
  }

  @Post()
  @Requires('tickets:write')
  @UseInterceptors(IdempotencyInterceptor)
  @ZodSerializerDto(V1TicketDetailDto)
  async create(
    @Body(new ZodValidationPipe(V1TicketCreateRequestDto)) body: V1TicketCreateRequestDto,
  ): Promise<V1TicketDetail> {
    const key = apiKeyPrincipal();
    return toV1Detail(await this.#tickets.create(key.brandId, key, { ...body, channel: 'api' }));
  }

  @Get(':ticketId')
  @Requires('tickets:read')
  @ZodSerializerDto(V1TicketDetailDto)
  async find(
    @Param(new ZodValidationPipe(V1TicketParamDto)) { ticketId }: V1TicketParamDto,
  ): Promise<V1TicketDetail> {
    return toV1Detail(
      await this.#tickets.find(ticketId, { withContacts: keyHolds('contacts:read') }),
    );
  }

  @Patch(':ticketId')
  @Requires('tickets:write')
  @ZodSerializerDto(V1TicketDto)
  update(
    @Param(new ZodValidationPipe(V1TicketParamDto)) { ticketId }: V1TicketParamDto,
    @Body(new ZodValidationPipe(V1TicketUpdateRequestDto)) body: V1TicketUpdateRequestDto,
  ): Promise<Ticket> {
    const key = apiKeyPrincipal();
    return this.#tickets.update(key.brandId, key, ticketId, body);
  }

  /** The admin's soft delete: hidden from every view, purged by retention. */
  @Delete(':ticketId')
  @Requires('tickets:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(V1TicketParamDto)) { ticketId }: V1TicketParamDto,
  ): Promise<void> {
    const key = apiKeyPrincipal();
    await this.#tickets.remove(key.brandId, key, ticketId);
  }

  @Get(':ticketId/messages')
  @Requires('tickets:read')
  @ZodSerializerDto(V1TicketMessagePageDto)
  messages(
    @Param(new ZodValidationPipe(V1TicketParamDto)) { ticketId }: V1TicketParamDto,
    @Query(new ZodValidationPipe(V1MessagePageQueryDto)) query: V1MessagePageQueryDto,
  ): Promise<TicketMessagePage> {
    return this.#tickets.messages(ticketId, query);
  }

  @Post(':ticketId/messages')
  @Requires('tickets:write')
  @UseInterceptors(IdempotencyInterceptor)
  @ZodSerializerDto(V1TicketMessageDto)
  addMessage(
    @Param(new ZodValidationPipe(V1TicketParamDto)) { ticketId }: V1TicketParamDto,
    @Body(new ZodValidationPipe(V1MessageCreateRequestDto)) body: V1MessageCreateRequestDto,
  ): Promise<TicketMessage> {
    const key = apiKeyPrincipal();
    return this.#tickets.addMessage(key.brandId, key, ticketId, body);
  }
}

/** The ticket and the start of its thread; the desk's activity, CSAT and SLA panels stay the desk's. */
const toV1Detail = (detail: TicketDetail): V1TicketDetail => ({
  ticket: detail.ticket,
  messages: detail.messages.messages,
});

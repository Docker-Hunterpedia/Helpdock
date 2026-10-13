import type { MetaDeliveryList, MetaTicketContextResponse } from '@helpdock/schemas';
import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import {
  MetaDeliveryListDto,
  MetaDeliveryParamDto,
  MetaTicketContextDto,
  MetaTicketParamDto,
} from './dto.js';
import { MetaDeliveriesService } from './meta-deliveries.service.js';

/**
 * The ticket view's Meta half (M10-06), the twins of `TicketTelegramController`
 * and `TicketTelegramContextController`. The account routes are M10-07's, in
 * `meta-accounts.controller.ts`.
 */

/**
 * The thread's "Not delivered · Retry" for a Meta ticket. Reading is
 * `ticket:read`; retrying a send is working the ticket, `ticket:write`, as for
 * email and Telegram.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/meta/deliveries')
export class TicketMetaDeliveriesController {
  readonly #deliveries: MetaDeliveriesService;

  constructor(@Inject(MetaDeliveriesService) deliveries: MetaDeliveriesService) {
    this.#deliveries = deliveries;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(MetaDeliveryListDto)
  list(
    @Param(new ZodValidationPipe(MetaTicketParamDto)) { ticketId }: MetaTicketParamDto,
  ): Promise<MetaDeliveryList> {
    return this.#deliveries.list(getTx(), ticketId);
  }

  /** `409` with `meta.reason: "reply-window-closed"` for a reply the window refused. */
  @Post(':deliveryId/retry')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async retry(
    @Param(new ZodValidationPipe(MetaDeliveryParamDto))
    { brandId, ticketId, deliveryId }: MetaDeliveryParamDto,
  ): Promise<void> {
    await this.#deliveries.retry(getTx(), brandId, ticketId, deliveryId);
  }
}

/**
 * Who the thread is with, through which account, whether a reply may be written
 * now, and each reply's delivery, in one read: the channel chip, the "via"
 * line, the ReplyWindowStrip and the ChannelIdentityCard.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/meta')
export class TicketMetaContextController {
  readonly #deliveries: MetaDeliveriesService;

  constructor(@Inject(MetaDeliveriesService) deliveries: MetaDeliveriesService) {
    this.#deliveries = deliveries;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(MetaTicketContextDto)
  context(
    @Param(new ZodValidationPipe(MetaTicketParamDto)) { ticketId }: MetaTicketParamDto,
  ): Promise<MetaTicketContextResponse> {
    return this.#deliveries.ticketContext(getTx(), ticketId);
  }
}

import {
  type TelegramBot,
  type TelegramBotList,
  type TelegramBotStatus,
  type TelegramDeliveryList,
  type TelegramTestResult,
  type TelegramWebhookResult,
  telegramTestResultSchema,
  telegramWebhookResultSchema,
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
  Post,
  Put,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import {
  TelegramBotCreateDto,
  TelegramBotDto,
  TelegramBotListDto,
  TelegramBotParamDto,
  TelegramBotStatusDto,
  TelegramBotUpdateDto,
  TelegramBrandParamDto,
  TelegramDeliveryListDto,
  TelegramDeliveryParamDto,
  TelegramTicketParamDto,
} from './dto.js';
import { TelegramBotsService } from './telegram-bots.service.js';
import { TelegramDeliveriesService } from './telegram-deliveries.service.js';

/**
 * Channels › Telegram (M6-05): the bot list and form, "Test connection", "Set
 * webhook" and the health panel.
 *
 * **`brand:manage` throughout**, reading included, as for mailboxes: a bot
 * carries a token and decides where a brand's chats land, and DOMAIN-RULES
 * §1.2 gives channels to the Admin.
 */
@Controller('api/brands/:brandId/telegram/bots')
export class TelegramBotsController {
  readonly #bots: TelegramBotsService;

  constructor(@Inject(TelegramBotsService) bots: TelegramBotsService) {
    this.#bots = bots;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(TelegramBotListDto)
  list(
    @Param(new ZodValidationPipe(TelegramBrandParamDto)) _params: TelegramBrandParamDto,
  ): Promise<TelegramBotList> {
    return this.#bots.list(getTx());
  }

  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(TelegramBotDto)
  create(
    @Param(new ZodValidationPipe(TelegramBrandParamDto)) _params: TelegramBrandParamDto,
    @Body(new ZodValidationPipe(TelegramBotCreateDto)) body: TelegramBotCreateDto,
  ): Promise<TelegramBot> {
    return this.#bots.create(requireTicketingContext(), body);
  }

  @Get(':botId')
  @Requires('brand:manage')
  @ZodSerializerDto(TelegramBotDto)
  get(
    @Param(new ZodValidationPipe(TelegramBotParamDto)) { botId }: TelegramBotParamDto,
  ): Promise<TelegramBot> {
    return this.#bots.get(getTx(), botId);
  }

  /** "Save bot": the whole form, so it is a `PUT`. */
  @Put(':botId')
  @Requires('brand:manage')
  @ZodSerializerDto(TelegramBotDto)
  update(
    @Param(new ZodValidationPipe(TelegramBotParamDto)) { botId }: TelegramBotParamDto,
    @Body(new ZodValidationPipe(TelegramBotUpdateDto)) body: TelegramBotUpdateDto,
  ): Promise<TelegramBot> {
    return this.#bots.update(requireTicketingContext(), botId, body);
  }

  @Delete(':botId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(TelegramBotParamDto)) { botId }: TelegramBotParamDto,
  ): Promise<void> {
    await this.#bots.remove(requireTicketingContext(), botId);
  }

  @Post(':botId/test')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  async test(
    @Param(new ZodValidationPipe(TelegramBotParamDto)) { botId }: TelegramBotParamDto,
  ): Promise<TelegramTestResult> {
    return telegramTestResultSchema.parse(await this.#bots.test(getTx(), botId));
  }

  @Post(':botId/webhook')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.OK)
  async setWebhook(
    @Param(new ZodValidationPipe(TelegramBotParamDto)) { botId }: TelegramBotParamDto,
  ): Promise<TelegramWebhookResult> {
    return telegramWebhookResultSchema.parse(
      await this.#bots.setWebhook(requireTicketingContext(), botId),
    );
  }

  @Get(':botId/status')
  @Requires('brand:manage')
  @ZodSerializerDto(TelegramBotStatusDto)
  status(
    @Param(new ZodValidationPipe(TelegramBotParamDto)) { botId }: TelegramBotParamDto,
  ): Promise<TelegramBotStatus> {
    return this.#bots.status(getTx(), botId);
  }
}

/**
 * The thread's "Not delivered · Retry" for a Telegram ticket (M6-02). Reading
 * is `ticket:read`; retrying a send is working the ticket, `ticket:write`, as
 * for email.
 */
@Controller('api/brands/:brandId/tickets/:ticketId/telegram/deliveries')
export class TicketTelegramController {
  readonly #deliveries: TelegramDeliveriesService;

  constructor(@Inject(TelegramDeliveriesService) deliveries: TelegramDeliveriesService) {
    this.#deliveries = deliveries;
  }

  @Get()
  @Requires('ticket:read')
  @ZodSerializerDto(TelegramDeliveryListDto)
  list(
    @Param(new ZodValidationPipe(TelegramTicketParamDto)) { ticketId }: TelegramTicketParamDto,
  ): Promise<TelegramDeliveryList> {
    return this.#deliveries.list(getTx(), ticketId);
  }

  @Post(':deliveryId/retry')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async retry(
    @Param(new ZodValidationPipe(TelegramDeliveryParamDto))
    { brandId, ticketId, deliveryId }: TelegramDeliveryParamDto,
  ): Promise<void> {
    await this.#deliveries.retry(getTx(), brandId, ticketId, deliveryId);
  }
}

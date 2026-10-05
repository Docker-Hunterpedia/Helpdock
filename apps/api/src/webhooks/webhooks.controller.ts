import type {
  Webhook,
  WebhookDelivery,
  WebhookDeliveryList,
  WebhookList,
  WebhookWithSecret,
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
import { Requires } from '../auth/route-declaration.js';
import { brandActor } from '../context/brand-actor.js';
import {
  WebhookBrandParamDto,
  WebhookCreateRequestDto,
  WebhookDeliveryDto,
  WebhookDeliveryListDto,
  WebhookDeliveryParamDto,
  WebhookDeliveryQueryDto,
  WebhookDto,
  WebhookListDto,
  WebhookParamDto,
  WebhookUpdateRequestDto,
  WebhookWithSecretDto,
} from './dto.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * M8-03: Settings › Webhooks, for the brand's Admin (`brand:manage`): an
 * endpoint receives the brand's tickets and contacts, every department's, so
 * adding one is a brand-level decision. The public API's `webhooks:manage`
 * routes (`api-v1/v1-webhooks.controller.ts`) are the same service. The screen
 * is a later task; this is its contract.
 */
@Controller('api/brands/:brandId/webhooks')
export class WebhooksController {
  readonly #webhooks: WebhooksService;

  constructor(@Inject(WebhooksService) webhooks: WebhooksService) {
    this.#webhooks = webhooks;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(WebhookListDto)
  list(
    @Param(new ZodValidationPipe(WebhookBrandParamDto)) _params: WebhookBrandParamDto,
  ): Promise<WebhookList> {
    return this.#webhooks.list(brandActor());
  }

  /** The one response besides a rotation that carries the signing secret. */
  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(WebhookWithSecretDto)
  create(
    @Param(new ZodValidationPipe(WebhookBrandParamDto)) _params: WebhookBrandParamDto,
    @Body(new ZodValidationPipe(WebhookCreateRequestDto)) body: WebhookCreateRequestDto,
  ): Promise<WebhookWithSecret> {
    return this.#webhooks.create(brandActor(), body);
  }

  @Get(':webhookId')
  @Requires('brand:manage')
  @ZodSerializerDto(WebhookDto)
  find(
    @Param(new ZodValidationPipe(WebhookParamDto)) { webhookId }: WebhookParamDto,
  ): Promise<Webhook> {
    return this.#webhooks.find(brandActor(), webhookId);
  }

  @Patch(':webhookId')
  @Requires('brand:manage')
  @ZodSerializerDto(WebhookDto)
  update(
    @Param(new ZodValidationPipe(WebhookParamDto)) { webhookId }: WebhookParamDto,
    @Body(new ZodValidationPipe(WebhookUpdateRequestDto)) body: WebhookUpdateRequestDto,
  ): Promise<Webhook> {
    return this.#webhooks.update(brandActor(), webhookId, body);
  }

  @Delete(':webhookId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(WebhookParamDto)) { webhookId }: WebhookParamDto,
  ): Promise<void> {
    await this.#webhooks.remove(brandActor(), webhookId);
  }

  @Post(':webhookId/rotate-secret')
  @Requires('brand:manage')
  @ZodSerializerDto(WebhookWithSecretDto)
  rotateSecret(
    @Param(new ZodValidationPipe(WebhookParamDto)) { webhookId }: WebhookParamDto,
  ): Promise<WebhookWithSecret> {
    return this.#webhooks.rotateSecret(brandActor(), webhookId);
  }

  @Get(':webhookId/deliveries')
  @Requires('brand:manage')
  @ZodSerializerDto(WebhookDeliveryListDto)
  deliveries(
    @Param(new ZodValidationPipe(WebhookParamDto)) { webhookId }: WebhookParamDto,
    @Query(new ZodValidationPipe(WebhookDeliveryQueryDto)) query: WebhookDeliveryQueryDto,
  ): Promise<WebhookDeliveryList> {
    return this.#webhooks.deliveries(brandActor(), webhookId, query);
  }

  @Post(':webhookId/deliveries/:deliveryId/replay')
  @Requires('brand:manage')
  @ZodSerializerDto(WebhookDeliveryDto)
  replay(
    @Param(new ZodValidationPipe(WebhookDeliveryParamDto))
    { webhookId, deliveryId }: WebhookDeliveryParamDto,
  ): Promise<WebhookDelivery> {
    return this.#webhooks.replay(brandActor(), webhookId, deliveryId);
  }
}

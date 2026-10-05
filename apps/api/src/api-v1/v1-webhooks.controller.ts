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
  UseInterceptors,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { brandActor } from '../context/brand-actor.js';
import {
  WebhookCreateRequestDto,
  WebhookDeliveryDto,
  WebhookDeliveryListDto,
  WebhookDeliveryQueryDto,
  WebhookDto,
  WebhookListDto,
  WebhookUpdateRequestDto,
  WebhookWithSecretDto,
} from '../webhooks/dto.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { V1WebhookDeliveryParamDto, V1WebhookParamDto } from './dto.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * M8-02: webhook endpoints over the public API, for a key with
 * `webhooks:manage` — the same service, rules and audit trail as the Admin's
 * settings (`webhooks/webhooks.controller.ts`).
 */
@Controller('api/v1/webhooks')
export class V1WebhooksController {
  readonly #webhooks: WebhooksService;

  constructor(@Inject(WebhooksService) webhooks: WebhooksService) {
    this.#webhooks = webhooks;
  }

  @Get()
  @Requires('webhooks:manage')
  @ZodSerializerDto(WebhookListDto)
  list(): Promise<WebhookList> {
    return this.#webhooks.list(brandActor());
  }

  @Post()
  @Requires('webhooks:manage')
  @UseInterceptors(IdempotencyInterceptor)
  @ZodSerializerDto(WebhookWithSecretDto)
  create(
    @Body(new ZodValidationPipe(WebhookCreateRequestDto)) body: WebhookCreateRequestDto,
  ): Promise<WebhookWithSecret> {
    return this.#webhooks.create(brandActor(), body);
  }

  @Get(':webhookId')
  @Requires('webhooks:manage')
  @ZodSerializerDto(WebhookDto)
  find(
    @Param(new ZodValidationPipe(V1WebhookParamDto)) { webhookId }: V1WebhookParamDto,
  ): Promise<Webhook> {
    return this.#webhooks.find(brandActor(), webhookId);
  }

  @Patch(':webhookId')
  @Requires('webhooks:manage')
  @ZodSerializerDto(WebhookDto)
  update(
    @Param(new ZodValidationPipe(V1WebhookParamDto)) { webhookId }: V1WebhookParamDto,
    @Body(new ZodValidationPipe(WebhookUpdateRequestDto)) body: WebhookUpdateRequestDto,
  ): Promise<Webhook> {
    return this.#webhooks.update(brandActor(), webhookId, body);
  }

  @Delete(':webhookId')
  @Requires('webhooks:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(V1WebhookParamDto)) { webhookId }: V1WebhookParamDto,
  ): Promise<void> {
    await this.#webhooks.remove(brandActor(), webhookId);
  }

  @Post(':webhookId/rotate-secret')
  @Requires('webhooks:manage')
  @ZodSerializerDto(WebhookWithSecretDto)
  rotateSecret(
    @Param(new ZodValidationPipe(V1WebhookParamDto)) { webhookId }: V1WebhookParamDto,
  ): Promise<WebhookWithSecret> {
    return this.#webhooks.rotateSecret(brandActor(), webhookId);
  }

  @Get(':webhookId/deliveries')
  @Requires('webhooks:manage')
  @ZodSerializerDto(WebhookDeliveryListDto)
  deliveries(
    @Param(new ZodValidationPipe(V1WebhookParamDto)) { webhookId }: V1WebhookParamDto,
    @Query(new ZodValidationPipe(WebhookDeliveryQueryDto)) query: WebhookDeliveryQueryDto,
  ): Promise<WebhookDeliveryList> {
    return this.#webhooks.deliveries(brandActor(), webhookId, query);
  }

  @Post(':webhookId/deliveries/:deliveryId/replay')
  @Requires('webhooks:manage')
  @ZodSerializerDto(WebhookDeliveryDto)
  replay(
    @Param(new ZodValidationPipe(V1WebhookDeliveryParamDto))
    { webhookId, deliveryId }: V1WebhookDeliveryParamDto,
  ): Promise<WebhookDelivery> {
    return this.#webhooks.replay(brandActor(), webhookId, deliveryId);
  }
}

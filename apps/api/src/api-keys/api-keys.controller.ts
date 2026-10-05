import type { ApiKey, ApiKeyCreated, ApiKeyList } from '@helpdock/schemas';
import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { brandActor } from '../context/brand-actor.js';
import { type ApiKeyActor, ApiKeysService } from './api-keys.service.js';
import {
  ApiKeyBrandParamDto,
  ApiKeyCreatedDto,
  ApiKeyCreateRequestDto,
  ApiKeyDto,
  ApiKeyListDto,
  ApiKeyParamDto,
} from './dto.js';

/**
 * M8-01: Settings › API keys, for the brand's Admin. `brand:manage`, which only
 * an Admin holds: a key acts for the whole brand, every department included,
 * so issuing one is a brand-level decision. The screen is a later task; this
 * is its contract.
 */
@Controller('api/brands/:brandId/api-keys')
export class ApiKeysController {
  readonly #keys: ApiKeysService;

  constructor(@Inject(ApiKeysService) keys: ApiKeysService) {
    this.#keys = keys;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(ApiKeyListDto)
  list(
    @Param(new ZodValidationPipe(ApiKeyBrandParamDto)) _params: ApiKeyBrandParamDto,
  ): Promise<ApiKeyList> {
    return this.#keys.list(actor());
  }

  /** The one response that carries the key itself. */
  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(ApiKeyCreatedDto)
  create(
    @Param(new ZodValidationPipe(ApiKeyBrandParamDto)) _params: ApiKeyBrandParamDto,
    @Body(new ZodValidationPipe(ApiKeyCreateRequestDto)) body: ApiKeyCreateRequestDto,
  ): Promise<ApiKeyCreated> {
    return this.#keys.create(actor(), body);
  }

  @Delete(':keyId')
  @Requires('brand:manage')
  @ZodSerializerDto(ApiKeyDto)
  revoke(@Param(new ZodValidationPipe(ApiKeyParamDto)) { keyId }: ApiKeyParamDto): Promise<ApiKey> {
    return this.#keys.revoke(actor(), keyId);
  }
}

const actor = (): ApiKeyActor => {
  const { tx, brandId, principalId } = brandActor();
  return { tx, brandId, userId: principalId };
};

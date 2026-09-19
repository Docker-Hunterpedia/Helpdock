import type { BrandPresence } from '@helpdock/schemas';
import { brandPresenceSchema } from '@helpdock/schemas';
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { BrandIdParamDto } from '../routes/dto.js';
import { PresenceService } from './presence.service.js';

export class BrandPresenceDto extends createZodDto(brandPresenceSchema) {}

/**
 * Who is online in a brand, right now, over REST.
 *
 * The socket is the notification and this is the truth (DOMAIN-RULES §7): a
 * screen renders this map first and then applies `presence:changed` events to
 * it, so a client that connects in the middle of a shift sees the room as it
 * is rather than as it changes.
 */
@Controller('api')
export class PresenceController {
  readonly #presence: PresenceService;

  constructor(@Inject(PresenceService) presence: PresenceService) {
    this.#presence = presence;
  }

  @Get('brands/:brandId/presence')
  @Requires('staff:read')
  @ZodSerializerDto(BrandPresenceDto)
  async brandPresence(
    @Param(new ZodValidationPipe(BrandIdParamDto)) { brandId }: BrandIdParamDto,
  ): Promise<BrandPresence> {
    return {
      brandId,
      presence: await this.#presence.mapOf(brandId),
      at: new Date().toISOString(),
    };
  }
}

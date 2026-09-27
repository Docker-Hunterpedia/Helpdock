import type { Db } from '@helpdock/db';
import { Controller, Get, Header, HttpStatus, Inject, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { DB } from '../runtime/tokens.js';
import { HcMediaParamDto } from './dto.js';
import { HelpCenterMediaService } from './media.service.js';

/**
 * The address an article's `<img src>` names (M5-02): a redirect to a
 * five-minute presigned URL for the WebP the pipeline made (ARCHITECTURE §9,
 * "short-lived presigned GET via api redirect; never public bucket").
 *
 * `@Public()`, because the public help center renders the same html for
 * visitors as the editor does for staff; `media.service.ts` says what that
 * means for images in internal articles. The redirect itself is not cached,
 * since what it points at expires.
 */
@Controller('api/help-center/brands/:brandId/media')
export class HelpCenterMediaController {
  readonly #media: HelpCenterMediaService;
  readonly #db: Db;

  constructor(@Inject(HelpCenterMediaService) media: HelpCenterMediaService, @Inject(DB) db: Db) {
    this.#media = media;
    this.#db = db;
  }

  @Get(':mediaId')
  @Public()
  @Header('Cache-Control', 'private, no-store')
  async redirect(
    @Param(new ZodValidationPipe(HcMediaParamDto)) { brandId, mediaId }: HcMediaParamDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const url = await this.#media.redirect(this.#db, brandId, mediaId);
    await reply.redirect(url, HttpStatus.FOUND);
  }
}

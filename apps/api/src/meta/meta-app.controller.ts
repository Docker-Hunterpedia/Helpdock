import type { MetaApp, MetaVerifyTokenReveal } from '@helpdock/schemas';
import { Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ZodSerializerDto } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { MetaAppDto, MetaVerifyTokenRevealDto } from './dto.js';
import { MetaAppService } from './meta-app.service.js';

/**
 * The App card of Channels › Meta (M10-02, drawn by M10-07): the install's one
 * Meta developer app. Install-wide, so `install:admin`, not a brand's
 * `brand:manage`; the app id and secrets are saved on Settings or by the
 * environment, and nothing here returns one.
 */
@Controller('api/meta/app')
export class MetaAppController {
  readonly #app: MetaAppService;

  constructor(@Inject(MetaAppService) app: MetaAppService) {
    this.#app = app;
  }

  @Get()
  @Requires('install:admin')
  @ZodSerializerDto(MetaAppDto)
  card(): Promise<MetaApp> {
    return this.#app.card();
  }

  /** A new verify token, in the answer once and never again. */
  @Post('verify-token')
  @Requires('install:admin')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(MetaVerifyTokenRevealDto)
  rotateVerifyToken(): Promise<MetaVerifyTokenReveal> {
    return this.#app.rotateVerifyToken();
  }
}

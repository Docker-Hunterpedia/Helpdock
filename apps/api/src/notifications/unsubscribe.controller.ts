import type { UnsubscribeView } from '@helpdock/schemas';
import { unsubscribeViewSchema } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import { UnsubscribeRequestDto, UnsubscribeTokenParamDto } from './dto.js';
import { UnsubscribeService } from './unsubscribe.service.js';

/**
 * The unsubscribe link's two calls (M14-11, RFC 8058). `@Public()`: the signed
 * token in the path is the credential, as the rating link's is, and the person
 * holding it has no session. `unsubscribe.service.ts` says what that allows.
 *
 * `POST` is the one-click address `List-Unsubscribe` names. Its body must be
 * `List-Unsubscribe=One-Click`, which the confirmation page sends too. `GET`
 * answers what the page draws and changes nothing.
 *
 * Both replace the token in the request path before the line is logged, so a
 * log is never a list of working links.
 */
@Controller('api/public/unsubscribe')
export class UnsubscribeController {
  readonly #unsubscribe: UnsubscribeService;

  constructor(@Inject(UnsubscribeService) unsubscribe: UnsubscribeService) {
    this.#unsubscribe = unsubscribe;
  }

  @Get(':token')
  @Public()
  async view(
    @Param(new ZodValidationPipe(UnsubscribeTokenParamDto)) { token }: UnsubscribeTokenParamDto,
    @Req() request: FastifyRequest,
  ): Promise<UnsubscribeView> {
    requireRequestContext().path = '/api/public/unsubscribe/:token';

    return unsubscribeViewSchema.parse(await this.#unsubscribe.view(token, request.ip));
  }

  @Post(':token')
  @Public()
  @HttpCode(HttpStatus.OK)
  async unsubscribe(
    @Param(new ZodValidationPipe(UnsubscribeTokenParamDto)) { token }: UnsubscribeTokenParamDto,
    @Body(new ZodValidationPipe(UnsubscribeRequestDto)) _body: UnsubscribeRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<UnsubscribeView> {
    requireRequestContext().path = '/api/public/unsubscribe/:token';

    return unsubscribeViewSchema.parse(await this.#unsubscribe.unsubscribe(token, request.ip));
  }
}

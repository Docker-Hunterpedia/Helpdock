import type { UnsubscribeView } from '@helpdock/schemas';
import { unsubscribeViewSchema } from '@helpdock/schemas';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { requireRequestContext } from '../context/request-context.js';
import { UnsubscribeRequestDto, UnsubscribeTokenParamDto } from './dto.js';
import { UnsubscribeService } from './unsubscribe.service.js';
import { readUnsubscribeForm } from './unsubscribe-body.js';

/**
 * The unsubscribe link's two calls (M14-11, RFC 8058). `@Public()`: the signed
 * token in the path is the credential, as the rating link's is, and the person
 * holding it has no session. `unsubscribe.service.ts` says what that allows.
 *
 * `POST` is the one-click address `List-Unsubscribe` names. Its body must be
 * `List-Unsubscribe=One-Click`, as a url-encoded form or as multipart (RFC 8058
 * §3.2), and the confirmation page sends it too. `GET` answers what the page
 * draws and changes nothing; a browser that opens this address, which is the
 * one `List-Unsubscribe` names, is sent on to the page at `/unsubscribe/<token>`
 * so that the address a person and a mail client share is one.
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
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('accept') accept?: string,
  ): Promise<UnsubscribeView | undefined> {
    requireRequestContext().path = '/api/public/unsubscribe/:token';

    // The page verifies the token itself; this only changes where a browser lands.
    if (wantsHtml(accept)) {
      await reply.redirect(`/unsubscribe/${token}`, HttpStatus.FOUND);
      return undefined;
    }

    return unsubscribeViewSchema.parse(await this.#unsubscribe.view(token, request.ip));
  }

  @Post(':token')
  @Public()
  @HttpCode(HttpStatus.OK)
  async unsubscribe(
    @Param(new ZodValidationPipe(UnsubscribeTokenParamDto)) { token }: UnsubscribeTokenParamDto,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<UnsubscribeView> {
    requireRequestContext().path = '/api/public/unsubscribe/:token';
    // The raw body is read from the request, not `@Body()`: a multipart body
    // arrives as bytes and is decoded first, then parsed by the schema here.
    new ZodValidationPipe(UnsubscribeRequestDto).transform(
      await readUnsubscribeForm(request.body, contentType),
      { type: 'body' },
    );

    return unsubscribeViewSchema.parse(await this.#unsubscribe.unsubscribe(token, request.ip));
  }
}

/** A browser asks for a page; the admin's own fetch and a script ask for anything or JSON. */
const wantsHtml = (accept: string | undefined): boolean => accept?.includes('text/html') === true;

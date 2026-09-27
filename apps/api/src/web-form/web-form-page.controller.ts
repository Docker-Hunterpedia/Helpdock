import {
  type WebFormPageParam,
  type WebFormPageQuery,
  webFormPageParamSchema,
  webFormPageQuerySchema,
} from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import type { FormBodyRoute } from '../channels/inbound/inbound-parse-body.js';
import {
  readFormBody,
  WEB_FORM_BODY_LIMIT,
  WEB_FORM_PATH,
  WebFormPage,
  type WebFormPageResponse,
} from './web-form-page.js';

/** For `registerFormBodies`: the form's two paths take multipart bodies up to its limit. */
export const WEB_FORM_ROUTE: FormBodyRoute = {
  matches: (url) => {
    const path = url.split('?')[0] ?? '';
    return path === WEB_FORM_PATH || path.startsWith(`${WEB_FORM_PATH}/`);
  },
  bodyLimit: WEB_FORM_BODY_LIMIT,
};

/**
 * The hosted form's public page (M4-09): `/contact` on a brand's help center
 * host, and `/contact/<brandId>` on the install's own host until the brand has
 * one (ADR 0013). `@Public()`: whoever is writing in has no account, which is
 * the point of the page.
 *
 * Static routes, so Fastify prefers them to the admin SPA's catch-all. The
 * answer is HTML with its own CSP, which replaces the `default-src 'none'`
 * every api response carries; it is never cached, because it holds a
 * single-use submission id.
 */
@Controller(WEB_FORM_PATH.slice(1))
export class WebFormPageController {
  readonly #page: WebFormPage;

  constructor(@Inject(WebFormPage) page: WebFormPage) {
    this.#page = page;
  }

  @Get()
  @Public()
  async show(
    @Query(new ZodValidationPipe(webFormPageQuerySchema)) { lang }: WebFormPageQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(
      reply,
      await this.#page.handle({ host: request.headers.host, lang, ip: request.ip }),
    );
  }

  @Post()
  @Public()
  async submit(
    @Query(new ZodValidationPipe(webFormPageQuerySchema)) { lang }: WebFormPageQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(
      reply,
      await this.#page.handle({
        host: request.headers.host,
        lang,
        ip: request.ip,
        body: await bodyOf(request),
      }),
    );
  }

  @Get(':brandId')
  @Public()
  async showForBrand(
    @Param(new ZodValidationPipe(webFormPageParamSchema)) { brandId }: WebFormPageParam,
    @Query(new ZodValidationPipe(webFormPageQuerySchema)) { lang }: WebFormPageQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(
      reply,
      await this.#page.handle({ host: request.headers.host, brandId, lang, ip: request.ip }),
    );
  }

  @Post(':brandId')
  @Public()
  async submitForBrand(
    @Param(new ZodValidationPipe(webFormPageParamSchema)) { brandId }: WebFormPageParam,
    @Query(new ZodValidationPipe(webFormPageQuerySchema)) { lang }: WebFormPageQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(
      reply,
      await this.#page.handle({
        host: request.headers.host,
        brandId,
        lang,
        ip: request.ip,
        body: await bodyOf(request),
      }),
    );
  }
}

/** An unreadable body is an empty one: the page then asks for every required field. */
const bodyOf = async (request: FastifyRequest) =>
  (await readFormBody(request.headers['content-type'], request.body)) ?? {
    fields: new Map<string, string[]>(),
    files: [],
  };

const send = async (reply: FastifyReply, response: WebFormPageResponse): Promise<void> => {
  await reply
    .code(response.status)
    .header('content-security-policy', response.contentSecurityPolicy)
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(response.html);
};

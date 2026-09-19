import type { Env } from '@helpdock/config';
import type {
  SetupAdminResponse,
  SetupBrandResponse,
  SetupCompleteResponse,
  SetupSmtpRequest,
  SetupSmtpResponse,
  SmtpTestResult,
} from '@helpdock/schemas';
import { SETUP_TOKEN_HEADER, setupSmtpRequestSchema } from '@helpdock/schemas';
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import {
  encodeRefreshCookie,
  REFRESH_COOKIE,
  refreshCookieAttributes,
} from '../auth/session/cookies.js';
import { ENV } from '../runtime/tokens.js';
import {
  SetupAdminRequestDto,
  SetupAdminResponseDto,
  SetupBrandRequestDto,
  SetupBrandResponseDto,
  SetupCompleteResponseDto,
  SetupSmtpResponseDto,
  SmtpTestRequestDto,
  SmtpTestResultDto,
} from './dto.js';
import { assertSameSiteRequest } from './same-site.js';
import { SetupService } from './setup.service.js';

/**
 * The four steps of the first-run wizard, and the only routes in the api that
 * write without a principal.
 *
 * They are `@Public()` because there is nobody to authenticate: the first of
 * them creates the person everything else is checked against. What stands in
 * for authorisation is in `SetupService` — the install must be `fresh` for step
 * 1, and every later step must present the token step 1 issued — so a route
 * here does little but shape the request and the reply.
 *
 * The one thing it does decide is `same-site.ts`: a credential-free write is
 * the one kind a `SameSite=Lax` cookie cannot protect, so every route here
 * refuses a request a browser made from another site.
 *
 * Step 2 is where the admin is signed in, and the only place in this file that
 * touches a cookie. It cannot happen earlier: a session names the brand it
 * lands in, and until step 2 there is no brand.
 */
@Controller('api/install/setup')
export class SetupController {
  readonly #setup: SetupService;
  readonly #env: Env;

  constructor(@Inject(SetupService) setup: SetupService, @Inject(ENV) env: Env) {
    this.#setup = setup;
    this.#env = env;
  }

  @Post('admin')
  @Public()
  @ZodSerializerDto(SetupAdminResponseDto)
  createAdmin(
    @Body(new ZodValidationPipe(SetupAdminRequestDto)) body: SetupAdminRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<SetupAdminResponse> {
    return this.#setup.createAdmin(body, { ip: this.#call(request).ip });
  }

  @Post('brand')
  @Public()
  @ZodSerializerDto(SetupBrandResponseDto)
  async createBrand(
    @Body(new ZodValidationPipe(SetupBrandRequestDto)) body: SetupBrandRequestDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SetupBrandResponse> {
    const { response, issued } = await this.#setup.createBrand(body, {
      ...this.#call(request),
      userAgent: request.headers['user-agent'],
    });

    if (issued !== null) {
      reply.setCookie(
        REFRESH_COOKIE,
        encodeRefreshCookie(issued.refreshCookieValue),
        refreshCookieAttributes(this.#env.APP_URL),
      );
    }

    return response;
  }

  @Post('smtp')
  @Public()
  @ZodSerializerDto(SetupSmtpResponseDto)
  saveSmtp(
    @Body(new ZodValidationPipe(setupSmtpRequestSchema)) body: SetupSmtpRequest,
    @Req() request: FastifyRequest,
  ): Promise<SetupSmtpResponse> {
    return this.#setup.saveSmtp(body, this.#call(request));
  }

  @Post('smtp/test')
  @Public()
  @ZodSerializerDto(SmtpTestResultDto)
  testSmtp(
    @Body(new ZodValidationPipe(SmtpTestRequestDto)) body: SmtpTestRequestDto,
    @Req() request: FastifyRequest,
  ): Promise<SmtpTestResult> {
    return this.#setup.testSmtp(body, this.#call(request));
  }

  @Post('complete')
  @Public()
  @ZodSerializerDto(SetupCompleteResponseDto)
  complete(@Req() request: FastifyRequest): Promise<SetupCompleteResponse> {
    return this.#setup.complete(this.#call(request));
  }

  /**
   * The address the limits count against, and the wizard token. The token is a
   * header rather than a body field so that every step's schema describes the
   * step and nothing else, and so a wrong token is refused the same way
   * wherever it appears.
   */
  #call(request: FastifyRequest): { readonly ip: string; readonly token: string | undefined } {
    assertSameSiteRequest(request.headers);
    const header = request.headers[SETUP_TOKEN_HEADER];

    return { ip: request.ip, token: Array.isArray(header) ? header[0] : header };
  }
}

import {
  type HcFeedbackForm,
  type HcSignOutForm,
  type HcSiteQuery,
  hcFeedbackFormSchema,
  hcSignOutFormSchema,
  hcSiteQuerySchema,
  type PortalConfirmForm,
  type PortalSessionForm,
  type PortalSignInForm,
  portalConfirmFormSchema,
  portalSessionFormSchema,
  portalSignInFormSchema,
} from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../../auth/route-declaration.js';
import { FEEDBACK_PATH, HC_FALLBACK_PREFIX, SIGN_OUT_PATH } from './paths.js';
import { HelpCenterSite, type SiteRequest, type SiteResponse } from './site.js';

/**
 * The published help center over HTTP (M5-03, ADR 0015).
 *
 * - On a brand's verified host every page is answered by the admin SPA's
 *   catch-all, which hands the request here when the host is a help center
 *   (`static/admin-spa.controller.ts`, {@link HelpCenterHostPages}): the
 *   pages have no path prefix to route on.
 * - On the install's own host, a brand with no domain yet is served under
 *   `/hc/<brandId>`, as ADR 0013 serves the web form under `/contact/<brandId>`.
 * - The two forms the pages post, "Was this helpful?" and "Sign out", have
 *   static routes on either.
 *
 * `@Public()`: a visitor has no account. Staff are recognised by the help
 * center's own cookie (`staff-access.ts`), which decides the audience; the
 * page, not the guard, is where that happens.
 */
@Controller()
export class HelpCenterSiteController {
  readonly #site: HelpCenterSite;

  constructor(@Inject(HelpCenterSite) site: HelpCenterSite) {
    this.#site = site;
  }

  @Get(`${HC_FALLBACK_PREFIX.slice(1)}/*`)
  @Public()
  async page(
    @Query(new ZodValidationPipe(hcSiteQuerySchema)) query: HcSiteQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'GET', false, query)));
  }

  @Post(`${HC_FALLBACK_PREFIX.slice(1)}/:brandId${FEEDBACK_PATH}`)
  @Public()
  async fallbackFeedback(
    @Body(new ZodValidationPipe(hcFeedbackFormSchema)) body: HcFeedbackForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', false, {}, body)));
  }

  @Post(`${HC_FALLBACK_PREFIX.slice(1)}/:brandId${SIGN_OUT_PATH}`)
  @Public()
  async fallbackSignOut(
    @Body(new ZodValidationPipe(hcSignOutFormSchema)) body: HcSignOutForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', false, {}, body)));
  }

  @Post(FEEDBACK_PATH.slice(1))
  @Public()
  async feedback(
    @Body(new ZodValidationPipe(hcFeedbackFormSchema)) body: HcFeedbackForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', true, {}, body)));
  }

  @Post(SIGN_OUT_PATH.slice(1))
  @Public()
  async signOut(
    @Body(new ZodValidationPipe(hcSignOutFormSchema)) body: HcSignOutForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', true, {}, body)));
  }

  // -------------------------------------------------------------- the portal (M21-02)
  // The forms the customer portal's pages post. Its pages are GETs the catch-all
  // and `/hc/*` above already hand to the site; a POST needs a static route.
  // `@Public()`: the sender is signed out or holds the portal's own cookie, which
  // the portal checks (`portal/portal-site.ts`), not the staff guard.

  @Post('sign-in')
  @Public()
  async portalSignIn(
    @Body(new ZodValidationPipe(portalSignInFormSchema)) body: PortalSignInForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', true, {}, body)));
  }

  @Post('sign-in/confirm')
  @Public()
  async portalConfirm(
    @Body(new ZodValidationPipe(portalConfirmFormSchema)) body: PortalConfirmForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', true, {}, body)));
  }

  @Post('sign-out')
  @Public()
  async portalSignOut(
    @Body(new ZodValidationPipe(portalSessionFormSchema)) body: PortalSessionForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', true, {}, body)));
  }

  @Post('sign-out-everywhere')
  @Public()
  async portalSignOutEverywhere(
    @Body(new ZodValidationPipe(portalSessionFormSchema)) body: PortalSessionForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', true, {}, body)));
  }

  @Post(`${HC_FALLBACK_PREFIX.slice(1)}/:brandId/sign-in`)
  @Public()
  async fallbackPortalSignIn(
    @Body(new ZodValidationPipe(portalSignInFormSchema)) body: PortalSignInForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', false, {}, body)));
  }

  @Post(`${HC_FALLBACK_PREFIX.slice(1)}/:brandId/sign-in/confirm`)
  @Public()
  async fallbackPortalConfirm(
    @Body(new ZodValidationPipe(portalConfirmFormSchema)) body: PortalConfirmForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', false, {}, body)));
  }

  @Post(`${HC_FALLBACK_PREFIX.slice(1)}/:brandId/sign-out`)
  @Public()
  async fallbackPortalSignOut(
    @Body(new ZodValidationPipe(portalSessionFormSchema)) body: PortalSessionForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', false, {}, body)));
  }

  @Post(`${HC_FALLBACK_PREFIX.slice(1)}/:brandId/sign-out-everywhere`)
  @Public()
  async fallbackPortalSignOutEverywhere(
    @Body(new ZodValidationPipe(portalSessionFormSchema)) body: PortalSessionForm,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await send(reply, await this.#site.handle(siteRequest(request, 'POST', false, {}, body)));
  }
}

/**
 * What the admin SPA's catch-all asks before serving the admin: is this host
 * a help center, and if so, the page. Registered under `HOST_PAGES`.
 */
export class HelpCenterHostPages {
  readonly #site: HelpCenterSite;

  constructor(site: HelpCenterSite) {
    this.#site = site;
  }

  serves(request: FastifyRequest): Promise<boolean> {
    return this.#site.servesHost(request.headers.host);
  }

  async serve(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const parsed = hcSiteQuerySchema.safeParse(request.query ?? {});
    await send(
      reply,
      await this.#site.handle(siteRequest(request, 'GET', true, parsed.success ? parsed.data : {})),
    );
  }
}

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export const siteRequest = (
  request: FastifyRequest,
  method: 'GET' | 'POST',
  byHost: boolean,
  query: HcSiteQuery,
  body?: unknown,
): SiteRequest => ({
  method,
  host: request.headers.host,
  path: (request.url.split('?')[0] ?? '/').replace(/\/{2,}/g, '/'),
  byHost,
  query,
  headers: {
    ifNoneMatch: header(request.headers['if-none-match']),
    acceptLanguage: header(request.headers['accept-language']),
    userAgent: header(request.headers['user-agent']),
    origin: header(request.headers.origin),
  },
  cookies: request.cookies ?? {},
  ip: request.ip,
  ...(body === undefined ? {} : { body }),
});

export const send = async (reply: FastifyReply, response: SiteResponse): Promise<void> => {
  for (const cookie of response.cookies) {
    reply.setCookie(cookie.name, cookie.value, {
      path: cookie.path,
      maxAge: cookie.maxAge,
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'lax',
    });
  }
  await reply.code(response.status).headers(response.headers).send(response.body);
  // After the reply has gone out, so the work behind it (the portal's lookup) cannot be timed.
  await response.after?.();
};

import type { Env } from '@helpdock/config';
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuthService } from '../auth/auth.service.js';
import { isAuthFailure } from '../auth/auth-failure.js';
import { factorsParams } from '../auth/second-factor-redirect.js';
import { encodeRefreshCookie, refreshCookieOf } from '../auth/session/cookies.js';
import { ENV } from '../runtime/tokens.js';
import { OidcFailure, type SsoAssertion } from './oidc-contracts.js';
import { SamlFailure } from './saml-xml.js';
import { SsoTestSignInService } from './test-sign-in.service.js';

@Injectable()
export class SsoSessionCompletion {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
    @Inject(SsoTestSignInService) private readonly tests: SsoTestSignInService,
  ) {}

  async signIn(
    reply: FastifyReply,
    flow: { assertion: SsoAssertion; returnTo: string },
    userAgent: string | undefined,
  ) {
    const previewUrl = await this.tests.complete(flow);
    if (previewUrl !== null) {
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      return reply.redirect(previewUrl, 302);
    }
    const outcome = await this.auth.completeSso(flow.assertion, userAgent);
    if (outcome.kind === 'totp-required')
      return this.redirect(reply, {
        challenge: outcome.challengeId,
        email: outcome.email,
        ...factorsParams(outcome.factors),
        returnTo: flow.returnTo,
      });
    if (outcome.kind === 'second-factor-enrolment-required')
      return this.redirect(reply, { enrol: outcome.challengeId, returnTo: flow.returnTo });
    const refresh = refreshCookieOf(this.env);
    reply.setCookie(
      refresh.name,
      encodeRefreshCookie(outcome.issued.refreshCookieValue),
      refresh.attributes,
    );
    return this.redirect(reply, {
      code: await this.auth.issueExchangeCode(outcome.issued),
      returnTo: flow.returnTo,
    });
  }

  refuse(reply: FastifyReply, error: unknown) {
    if (isAuthFailure(error)) return this.redirect(reply, { error: error.auth.code });
    if (error instanceof OidcFailure || error instanceof SamlFailure) {
      const known = [
        'sso-email-unverified',
        'sso-no-access',
        'sso-connection-disabled',
        'sso-required',
      ];
      return this.redirect(reply, {
        error: known.includes(error.code) ? error.code : 'sso-invalid-response',
      });
    }
    return this.redirect(reply, { error: 'unavailable' });
  }
  async redirect(reply: FastifyReply, params: Record<string, string>) {
    const url = new URL('/sign-in/complete', this.env.APP_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    await reply.redirect(url.toString(), 302);
  }
}

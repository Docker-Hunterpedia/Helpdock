import {
  type DomainCheckQuery,
  type DomainCheckResult,
  domainCheckQuerySchema,
} from '@helpdock/schemas';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { DomainCheckService } from './domain-check.service.js';
import { DomainCheckResultDto } from './dto.js';
import { createIpRateLimiter } from './ip-rate-limit.js';

/**
 * Caddy's on-demand TLS gate (ARCHITECTURE §3). It answers 200 only for a
 * verified help-center domain; anything else is a 403, and Caddy refuses the
 * handshake rather than asking a certificate authority for a certificate.
 *
 * `@Public()` because Caddy has no session and its `ask` cannot carry a header,
 * which is why the `/internal/*` shared secret of ARCHITECTURE §7 does not apply
 * here. Two things stand in its place: `docker/caddy/Caddyfile` answers 404 to
 * `/internal/*` from the outside, so the route is reachable only from inside the
 * Compose network, and the rate limit below bounds it for anyone who gets there
 * anyway.
 */
@Controller('internal')
export class DomainCheckController {
  /**
   * Caddy asks once per handshake for a host it has no certificate for, and
   * caches the answer for the life of the certificate. A minute's worth of
   * handshakes from one address is far more than that needs and far less than a
   * certificate authority's own limits.
   *
   * The key is `request.ip`, which under `TRUST_PROXY=true` is what
   * `x-forwarded-for` says. In the deployed topology Caddy calls this route
   * directly, over the Compose network and without that header, so the key is
   * Caddy's own address and the limit is effectively one budget for the
   * endpoint — which is the budget that matters here, because what it protects
   * is the certificate authority and the database behind it.
   */
  readonly #limiter = createIpRateLimiter({
    limit: 60,
    windowMs: 60_000,
    maxTrackedIps: 1024,
  });

  readonly #domains: DomainCheckService;

  constructor(@Inject(DomainCheckService) domains: DomainCheckService) {
    this.#domains = domains;
  }

  @Get('domain-check')
  @Public()
  @ZodSerializerDto(DomainCheckResultDto)
  async check(
    // The schema is named here rather than left to the global pipe's DTO
    // metadata: that metadata comes from `design:paramtypes`, which an
    // `import type` erases, and this is the only thing standing between a
    // request and a hostname the rest of the handler trusts.
    @Query(new ZodValidationPipe(domainCheckQuerySchema)) { domain }: DomainCheckQuery,
    @Req() request: FastifyRequest,
  ): Promise<DomainCheckResult> {
    if (!this.#limiter.allow(request.ip)) {
      throw new HttpException('Too many domain checks', HttpStatus.TOO_MANY_REQUESTS);
    }

    if (!(await this.#domains.isVerifiedHelpcenterDomain(domain))) {
      // The same answer for a domain nobody added and one that is not verified
      // yet: the caller chose the hostname, so it learns nothing either way.
      throw new ForbiddenException('This domain is not a verified help center domain');
    }

    return { domain };
  }
}

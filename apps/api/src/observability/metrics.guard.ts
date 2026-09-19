import type { Env } from '@helpdock/config';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Logger } from '../logging/logger.js';
import { ENV } from '../runtime/tokens.js';
import { bearerToken, metricsAccess } from './metrics-access.js';
import { OBSERVABILITY_LOGGER } from './tokens.js';

/**
 * The door in front of `/metrics`, per {@link ./metrics-access.js}.
 *
 * It answers 404 rather than 401 or 403. A 401 would advertise that the
 * endpoint exists and invite a token guess; a 404 tells a scanner what it would
 * have learned from an install that had no metrics at all. The reason is
 * written to the log instead, where the operator whose scraper is being refused
 * can read it and a token guess leaves a trail.
 */
@Injectable()
export class MetricsGuard implements CanActivate {
  readonly #env: Env;
  readonly #logger: Logger;

  constructor(@Inject(ENV) env: Env, @Inject(OBSERVABILITY_LOGGER) logger: Logger) {
    this.#env = env;
    this.#logger = logger;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const proxied = viaProxy(request, this.#env.TRUST_PROXY);

    const access = metricsAccess({
      // The socket's peer, not `request.ip`: with `TRUST_PROXY` on, `request.ip`
      // is whatever `x-forwarded-for` claimed, and a client must not be able to
      // claim a private address.
      remoteAddress: request.socket.remoteAddress,
      authorization: request.headers.authorization,
      expectedToken: this.#env.METRICS_TOKEN,
      viaProxy: proxied,
    });

    if (access === 'denied') {
      this.#logger.warn(
        {
          peer: request.socket.remoteAddress ?? null,
          viaProxy: proxied,
          // Whether a bearer was offered, never the bearer itself.
          bearerPresented: bearerToken(request.headers.authorization) !== undefined,
          tokenConfigured: this.#env.METRICS_TOKEN !== undefined,
        },
        'Refused a /metrics scrape',
      );
      throw new NotFoundException('Cannot GET /metrics');
    }

    return true;
  }
}

/**
 * Whether a reverse proxy this install controls is in front of the request.
 *
 * Both halves are needed. `TRUST_PROXY` is the operator's statement that a
 * proxy sets these headers; without it a forwarding header is just something a
 * client wrote, and honouring it would let anyone give up an access they never
 * had — harmless here, but it would also let them force the token path on a
 * scraper that should not need one.
 */
const viaProxy = (request: FastifyRequest, trustProxy: boolean): boolean =>
  trustProxy &&
  (request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined);

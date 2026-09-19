import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from '@helpdock/config';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { BRAND_RESOLVER, ENV, LOGGER } from '../runtime/tokens.js';
import type { BrandResolver } from './brand-resolver.js';
import { RequestContext, runInRequestContext } from './request-context.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

/**
 * Step 1 of ARCHITECTURE §6: give the request an id, start its clock, work out
 * which brand its host names, and put all of it in the AsyncLocalStorage the
 * guards, the interceptor and the services read.
 *
 * It runs on the Fastify adapter through `@fastify/middie`, so `req` and `res`
 * are the raw Node objects. Route parameters are not known yet, which is why
 * the target brand is the permission guard's job and only the host-derived one
 * is settled here.
 */

/**
 * `@fastify/middie` rewrites `req.url` to the part after the prefix a
 * middleware is mounted on, and keeps the whole one in `originalUrl`. This
 * middleware is mounted on `{*path}`, so `req.url` would be `/` for every
 * request and both the log and the audit trail would say so.
 */
interface MountedRequest extends IncomingMessage {
  readonly originalUrl?: string;
}
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  readonly #env: Env;
  readonly #logger: Logger;
  readonly #brandResolver: BrandResolver;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) logger: Logger,
    @Inject(BRAND_RESOLVER) brandResolver: BrandResolver,
  ) {
    this.#env = env;
    this.#logger = logger;
    this.#brandResolver = brandResolver;
  }

  use(req: MountedRequest, res: ServerResponse, next: (error?: unknown) => void): void {
    const context = new RequestContext({
      requestId: resolveRequestId(req.headers[REQUEST_ID_HEADER], {
        trustProxy: this.#env.TRUST_PROXY,
      }),
      method: req.method ?? 'GET',
      path: pathOf(req.originalUrl ?? req.url),
    });

    // Echoed so a client can quote it when reporting a failure, and so a proxy
    // log and an api log can be joined on it.
    res.setHeader(REQUEST_ID_HEADER, context.requestId);

    runInRequestContext(context, () => {
      this.#logWhenFinished(res, context);
      this.#brandResolver.resolve(req.headers.host).then((brand) => {
        context.hostBrandId = brand?.brandId ?? null;
        next();
      }, next);
    });
  }

  /**
   * One line per request: the id, the route, the outcome, how long it took and
   * who asked. Never a body, never a query string, never a header.
   *
   * The bindings are read from the context the listener closes over rather than
   * from the AsyncLocalStorage: `finish` is emitted by Node when the socket
   * drains, and an event listener runs in the emitter's async context, not the
   * one it was registered in.
   */
  #logWhenFinished(res: ServerResponse, context: RequestContext): void {
    res.once('finish', () => {
      const brandId = context.targetBrandId ?? context.hostBrandId;

      this.#logger.info(
        {
          requestId: context.requestId,
          ...(brandId === null ? {} : { brandId }),
          method: context.method,
          path: context.path,
          status: res.statusCode,
          durationMs: Math.round(context.durationMs),
          principalType: context.principal?.type ?? null,
        },
        'request',
      );
    });
  }
}

/**
 * The path without its query string. A query may carry a search term or an
 * email address, and ARCHITECTURE §14 puts no request content in the log.
 */
const pathOf = (url: string | undefined): string => {
  if (url === undefined) {
    return '/';
  }
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
};

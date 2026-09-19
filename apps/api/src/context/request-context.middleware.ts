import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from '@helpdock/config';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { principalIdOf } from '../auth/principal.js';
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
   * One line per request: the id, the trace it belongs to, the route, the
   * outcome, how long it took and who asked. Never a body, never a query
   * string, never a header, and never an email — the principal is named by its
   * id, which is the same handle `audit_log` uses (ARCHITECTURE §14).
   *
   * The bindings are read from the context the listener closes over rather than
   * from the AsyncLocalStorage: `finish` is emitted by Node when the socket
   * drains, and an event listener runs in the emitter's async context, not the
   * one it was registered in. The trace id is captured for the same reason —
   * the active span is gone by the time `finish` fires, so it is read while the
   * request is still in flight.
   */
  #logWhenFinished(res: ServerResponse, context: RequestContext): void {
    const span = trace.getActiveSpan()?.spanContext();
    const traceIds =
      span !== undefined && isSpanContextValid(span)
        ? { traceId: span.traceId, spanId: span.spanId }
        : {};

    res.once('finish', () => {
      const brandId = context.targetBrandId ?? context.hostBrandId;
      const principal = context.principal;

      this.#logger.info(
        {
          requestId: context.requestId,
          ...traceIds,
          ...(brandId === null ? {} : { brandId }),
          method: context.method,
          path: context.path,
          status: res.statusCode,
          durationMs: Math.round(context.durationMs),
          principalType: principal?.type ?? null,
          ...(principal === null ? {} : { principalId: principalIdOf(principal) }),
        },
        'request',
      );
    });
  }
}

/**
 * The path alone. A query may carry a search term or an email address, and
 * ARCHITECTURE §14 puts no request content in the log.
 *
 * Parsed rather than cut at the first `?`, because a request target may arrive
 * in absolute form — `GET http://user:pw@host/x HTTP/1.1` is legal and Node
 * hands it over as-is. Cutting would log the host and its userinfo, and an
 * install-scope route writes this same value into `audit_log.targetId`.
 */
const pathOf = (url: string | undefined): string => {
  if (url === undefined) {
    return '/';
  }

  try {
    return new URL(url, 'http://helpdock.invalid').pathname;
  } catch {
    /* c8 ignore next 2 -- `URL` with a base parses anything Node accepted as a target. */
    return '/';
  }
};

import { WIDGET_API_PREFIX } from '@helpdock/schemas';
import type { FastifyInstance } from 'fastify';

/**
 * CORS for the widget's routes, which are called from customers' sites.
 *
 * The headers echo the page's `Origin` without consulting the allow-list,
 * and that is deliberate: CORS only decides whether a *browser* lets a page
 * read a response, and every widget route already refuses an origin the
 * brand has not allowed with 403 `origin_not_allowed` (`widget-gate.ts`).
 * Checking twice would cost a database read per preflight and prove nothing
 * more. No cookie is ever read on these routes — the credential is the
 * `Authorization: Visitor` header — so `Access-Control-Allow-Credentials` is
 * never sent, and a page cannot ride on anybody's session.
 *
 * `Cross-Origin-Resource-Policy: cross-origin` overrides the api's
 * `same-origin` default for these routes alone (`http/security-headers.ts`).
 */

export const WIDGET_CORS_MAX_AGE_SECONDS = 600;

const isWidgetRoute = (url: string): boolean => url.startsWith(`${WIDGET_API_PREFIX}/`);

/** The CORS headers for a widget response to `origin`, or none when there is no origin. */
export const widgetCorsHeaders = (origin: string | undefined): Record<string, string> =>
  origin === undefined || origin === ''
    ? { 'cross-origin-resource-policy': 'cross-origin' }
    : {
        'access-control-allow-origin': origin,
        'access-control-expose-headers': 'etag',
        vary: 'Origin',
        'cross-origin-resource-policy': 'cross-origin',
      };

export const registerWidgetCors = (fastify: FastifyInstance): void => {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isWidgetRoute(request.url)) {
      return;
    }
    const origin = request.headers.origin;
    void reply.headers(widgetCorsHeaders(origin));

    if (request.method === 'OPTIONS') {
      await reply
        .code(204)
        .headers({
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, if-none-match',
          'access-control-max-age': String(WIDGET_CORS_MAX_AGE_SECONDS),
        })
        .send();
    }
  });
};

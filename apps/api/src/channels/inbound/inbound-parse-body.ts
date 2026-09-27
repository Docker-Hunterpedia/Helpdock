import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';

/**
 * What the few routes that take a form body need of Fastify that no other
 * route does, registered on the instance before Nest adds its routes: the
 * inbound-parse endpoints (M2-03) and the hosted web form (M4-09).
 *
 * - **A larger body.** A message with attachments is megabytes: Postmark's JSON
 *   carries them base64-encoded, SendGrid and Mailgun as form files, and the
 *   web form's customer as files they chose. Every other route keeps Fastify's
 *   1 MB, because `onRoute` raises the limit on these routes alone.
 * - **Multipart bodies.** The api otherwise has no parser for
 *   `multipart/form-data`, so it is accepted as raw bytes on these routes and
 *   refused with 415 everywhere else; each controller decodes it with the
 *   platform's `FormData` parser, so no multipart dependency is needed.
 *   Url-encoded forms arrive through the parser Nest's Fastify adapter
 *   already registers.
 */

export interface FormBodyRoute {
  /** True for a route path (`/contact/:brandId`) or a request url this covers. */
  readonly matches: (url: string) => boolean;
  readonly bodyLimit: number;
}

export const INBOUND_PARSE_PREFIX = '/internal/inbound-parse/';

/** Above every provider's own inbound cap (Postmark 35 MB, SendGrid 30 MB, Mailgun 25 MB). */
export const INBOUND_PARSE_BODY_LIMIT = 40 * 1024 * 1024;

export const INBOUND_PARSE_ROUTE: FormBodyRoute = {
  matches: (url) => url.startsWith(INBOUND_PARSE_PREFIX),
  bodyLimit: INBOUND_PARSE_BODY_LIMIT,
};

/** Url-encoded bodies are Nest's own `@fastify/formbody` parser's, and arrive as objects. */
const FORM_TYPES = ['multipart/form-data'];

export const registerFormBodies = (
  fastify: FastifyInstance,
  routes: readonly FormBodyRoute[],
): void => {
  const routeFor = (url: string): FormBodyRoute | undefined =>
    routes.find((route) => route.matches(url));

  fastify.addHook('onRoute', (route) => {
    const match = routeFor(route.url);
    if (match !== undefined) {
      route.bodyLimit = match.bodyLimit;
    }
  });

  fastify.addContentTypeParser(FORM_TYPES, { parseAs: 'buffer' }, (request, body, done) => {
    if (routeFor(request.url) === undefined) {
      // A Nest exception, so the api's filter answers it like any other refusal.
      done(new UnsupportedMediaTypeException('This route accepts JSON only'), undefined);
      return;
    }
    done(null, body);
  });
};

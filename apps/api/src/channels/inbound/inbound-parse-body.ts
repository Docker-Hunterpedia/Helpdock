import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';

/**
 * What `/internal/inbound-parse/*` needs of Fastify that no other route does
 * (M2-03), registered on the instance before Nest adds its routes.
 *
 * - **A larger body.** A message with attachments is megabytes: Postmark's JSON
 *   carries them base64-encoded, SendGrid and Mailgun as form files. Every
 *   other route keeps Fastify's 1 MB, because `onRoute` raises the limit on
 *   these routes alone.
 * - **Multipart bodies.** SendGrid and Mailgun post `multipart/form-data`.
 *   The api otherwise has no parser for it, so it is accepted as raw bytes on
 *   these routes and refused with 415 everywhere else; the controller decodes
 *   it with the platform's `FormData` parser, so no multipart dependency is
 *   needed. Mailgun's url-encoded form arrives through the parser Nest's
 *   Fastify adapter already registers.
 */

export const INBOUND_PARSE_PREFIX = '/internal/inbound-parse/';

/** Above every provider's own inbound cap (Postmark 35 MB, SendGrid 30 MB, Mailgun 25 MB). */
export const INBOUND_PARSE_BODY_LIMIT = 40 * 1024 * 1024;

/** Url-encoded bodies are Nest's own `@fastify/formbody` parser's, and arrive as objects. */
const FORM_TYPES = ['multipart/form-data'];

export const registerInboundParseBody = (fastify: FastifyInstance): void => {
  fastify.addHook('onRoute', (route) => {
    if (route.url.startsWith(INBOUND_PARSE_PREFIX)) {
      route.bodyLimit = INBOUND_PARSE_BODY_LIMIT;
    }
  });

  fastify.addContentTypeParser(FORM_TYPES, { parseAs: 'buffer' }, (request, body, done) => {
    if (!request.url.startsWith(INBOUND_PARSE_PREFIX)) {
      // A Nest exception, so the api's filter answers it like any other refusal.
      done(new UnsupportedMediaTypeException('This route accepts JSON only'), undefined);
      return;
    }
    done(null, body);
  });
};

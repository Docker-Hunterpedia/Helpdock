import { metaWebhookPath } from '@helpdock/schemas';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/**
 * What Meta's webhook needs of Fastify that no other route does (M10-02),
 * registered on the adapter before Nest adds its routes.
 *
 * - **The bytes that were signed.** `X-Hub-Signature-256` is an HMAC of the
 *   body as Meta wrote it; re-serialising the parsed JSON does not reproduce it
 *   (key order, escapes, number forms). The JSON parser keeps the buffer on
 *   `request.rawBody` for this route alone, so no other route holds a second
 *   copy of its body for the length of the request.
 * - **Meta's larger body.** A batch is up to 3 MiB; Fastify's default is 1 MiB,
 *   which every other route keeps because `onRoute` raises the limit on this
 *   one only.
 *
 * Nest registers its own `application/json` parser when the app initialises and
 * would then refuse a second one for the type, so the adapter is asked to
 * register its parsers now (it then skips them at init) and the JSON one is
 * replaced. The replacement parses with Fastify's own default parser, set to
 * the same prototype-poisoning actions Nest uses, so `{"__proto__": …}` is
 * refused on this route as on every other.
 */

/** Meta's documented cap on a webhook payload. */
export const META_WEBHOOK_BODY_LIMIT = 3 * 1024 * 1024;

const JSON_TYPE = 'application/json';

type BufferParser = (
  request: FastifyRequest,
  body: Buffer,
  done: (error: Error | null, parsed?: unknown) => void,
) => void;

/** True for the webhook's path, query string or not. */
const isMetaWebhook = (url: string): boolean => url.split('?', 1)[0] === metaWebhookPath();

export const registerMetaWebhookBody = (adapter: FastifyAdapter): void => {
  const fastify = adapter.getInstance();

  adapter.registerParserMiddleware();
  fastify.removeContentTypeParser(JSON_TYPE);

  fastify.addHook('onRoute', (route) => {
    if (isMetaWebhook(route.url)) {
      route.bodyLimit = META_WEBHOOK_BODY_LIMIT;
    }
  });

  const { bodyLimit, onProtoPoisoning, onConstructorPoisoning } = fastify.initialConfig;
  // Fastify types its default JSON parser for a string body; it parses the buffer
  // too, which is how Nest's own adapter calls it.
  const parseJson = fastify.getDefaultJsonParser(
    onProtoPoisoning ?? 'error',
    onConstructorPoisoning ?? 'error',
  ) as unknown as BufferParser;
  fastify.addContentTypeParser<Buffer>(
    JSON_TYPE,
    { parseAs: 'buffer', ...(bodyLimit === undefined ? {} : { bodyLimit }) },
    (request, body, done) => {
      if (isMetaWebhook(request.url)) {
        (request as RawBodyRequest<typeof request>).rawBody = body;
      }
      parseJson(request, body, done);
    },
  );
};

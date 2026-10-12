import { META_SIGNATURE_HEADER, metaWebhookPath } from '@helpdock/schemas';
import { HttpException } from '@nestjs/common';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import type { MetaSigner } from './meta-webhook.service.js';

/**
 * What Meta's webhook needs of Fastify that no other route does (M10-02),
 * registered on the adapter before Nest adds its routes.
 *
 * - **The signature is checked over the bytes Meta wrote, before they are
 *   parsed.** `X-Hub-Signature-256` is an HMAC of the body as Meta wrote it;
 *   re-serialising the parsed JSON does not reproduce it (key order, escapes,
 *   number forms). So this route's parser takes the buffer, charges the
 *   address's budget, verifies the signature over the buffer and only then
 *   parses it: a body that is unsigned or unparseable costs the read and
 *   nothing more, and a request the limiter refuses never reaches `JSON.parse`
 *   (ADR 0025, 4). Fastify runs the content-type parser before the Nest
 *   handler, which is why the check lives here and not in the controller. The
 *   other routes keep no second copy of their body for the length of the
 *   request.
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

/** What the parser asks of the webhook: the address's budget and the signature. */
export interface MetaWebhookGate {
  /** True while the address is within its budget. */
  admit(ip: string): boolean;
  /** Which secret made the signature of these bytes, or undefined when none did. */
  authenticate(raw: Buffer, signature: string | undefined): Promise<MetaSigner | undefined>;
}

/** A request the parser has authenticated, carrying who signed it to the handler. */
export interface MetaWebhookRequest {
  metaSigner?: MetaSigner;
}

/** True for the webhook's path, query string or not. */
const isMetaWebhook = (url: string): boolean => url.split('?', 1)[0] === metaWebhookPath();

/**
 * An `HttpException`, which the api's exception filter answers with its own
 * status, carrying `statusCode` too, which is what Fastify's own error handler
 * reads when no filter is installed.
 */
const refusal = (statusCode: number, message: string): HttpException =>
  Object.assign(new HttpException(message, statusCode), { statusCode });

/**
 * `gate` is undefined when the install does not mount the Meta module: the
 * route does not exist then, and its path is parsed like any other.
 */
export const registerMetaWebhookBody = (adapter: FastifyAdapter, gate?: MetaWebhookGate): void => {
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
  const parse = (request: FastifyRequest, body: Buffer): Promise<unknown> =>
    new Promise((resolve, reject) => {
      parseJson(request, body, (error, parsed) =>
        error === null ? resolve(parsed) : reject(error),
      );
    });

  fastify.addContentTypeParser<Buffer>(
    JSON_TYPE,
    { parseAs: 'buffer', ...(bodyLimit === undefined ? {} : { bodyLimit }) },
    async (request: FastifyRequest, body: Buffer) => {
      if (gate === undefined || !isMetaWebhook(request.url)) {
        return parse(request, body);
      }

      if (!gate.admit(request.ip)) {
        throw refusal(429, 'Too many Meta requests');
      }
      const header = request.headers[META_SIGNATURE_HEADER];
      const signer = await gate.authenticate(body, typeof header === 'string' ? header : undefined);
      if (signer === undefined) {
        throw refusal(401, 'The Meta signature is missing or wrong');
      }
      (request as FastifyRequest & MetaWebhookRequest).metaSigner = signer;

      return parse(request, body);
    },
  );
};

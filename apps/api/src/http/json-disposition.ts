import type { FastifyInstance } from 'fastify';

/**
 * ASVS 14.4.2: every JSON answer says it is a file, not a page.
 *
 * `fetch` ignores `Content-Disposition`, so the admin, the widget and every API
 * client read the body as before. What changes is a browser *navigating* to an
 * API URL — a link in a phishing email, an `<iframe>` — which now downloads
 * `api.json` instead of rendering it, so a response that echoes user input can
 * never be interpreted as a document, whatever a future content sniffer thinks
 * of it. `nosniff` (helmet) covers the same ground from the other side.
 *
 * A route that already chose its own disposition (an export with a real file
 * name) keeps it.
 */

export const API_JSON_DISPOSITION = 'attachment; filename="api.json"';

const isJson = (contentType: unknown): boolean =>
  typeof contentType === 'string' && /^application\/([\w.+-]+\+)?json\b/i.test(contentType);

export const registerJsonDisposition = (fastify: FastifyInstance): void => {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    if (isJson(reply.getHeader('content-type')) && !reply.hasHeader('content-disposition')) {
      reply.header('content-disposition', API_JSON_DISPOSITION);
    }

    return payload;
  });
};

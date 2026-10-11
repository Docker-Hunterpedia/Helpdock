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
 *
 * ASVS 8.2.1: and no JSON answer is stored by a cache. What the api answers is
 * a brand's tickets, contacts and settings, so `Cache-Control: no-store` is the
 * default for all of it, errors included. A route that caches its JSON on
 * purpose says so itself and keeps its value: the widget's source maps, the
 * widget config (`no-cache` with an ETag), the admin's hashed assets. Pages
 * and scripts are not JSON and are not touched.
 */

export const API_JSON_DISPOSITION = 'attachment; filename="api.json"';
export const API_JSON_CACHE_CONTROL = 'no-store';

const isJson = (contentType: unknown): boolean =>
  typeof contentType === 'string' && /^application\/([\w.+-]+\+)?json\b/i.test(contentType);

export const registerJsonDisposition = (fastify: FastifyInstance): void => {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    if (isJson(reply.getHeader('content-type'))) {
      if (!reply.hasHeader('content-disposition')) {
        reply.header('content-disposition', API_JSON_DISPOSITION);
      }
      if (!reply.hasHeader('cache-control')) {
        reply.header('cache-control', API_JSON_CACHE_CONTROL);
      }
    }

    return payload;
  });
};

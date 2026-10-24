import type { FormBodyRoute } from '../channels/inbound/inbound-parse-body.js';

/**
 * The one-click POST's body (RFC 8058 §3.2): a mail client sends
 * `List-Unsubscribe=One-Click` as `multipart/form-data` or as a url-encoded
 * form, and the confirmation page sends the url-encoded one.
 *
 * The api parses multipart on a few named routes only (`registerFormBodies`),
 * and everything else answers 415. This route takes it with a body limit far
 * under Fastify's 1 MB: the whole body is one short field.
 */
export const UNSUBSCRIBE_ROUTE: FormBodyRoute = {
  matches: (url) => /^\/api\/public\/unsubscribe\/[^/?]+(?:\?|$)/.test(url),
  bodyLimit: 4 * 1024,
};

/**
 * The text fields of the body, as the url-encoded and JSON parsers would give
 * them. A multipart body arrives as raw bytes and is decoded with the
 * platform's `FormData` parser; one that does not decode has no fields, so the
 * schema refuses it as it refuses a missing one. Files are ignored.
 */
export const readUnsubscribeForm = async (
  body: unknown,
  contentType: string | undefined,
): Promise<unknown> => {
  if (!Buffer.isBuffer(body)) {
    return body;
  }

  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), {
      headers: { 'content-type': contentType ?? '' },
    }).formData();
  } catch {
    return {};
  }

  const fields: Record<string, string> = {};
  for (const [name, value] of form) {
    if (typeof value === 'string') {
      fields[name] = value;
    }
  }

  return fields;
};

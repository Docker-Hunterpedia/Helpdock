import { createHash } from 'node:crypto';

/**
 * The Content-Security-Policy the admin SPA needs.
 *
 * `securityHeaderOptions` gives every api response `default-src 'none'`, which
 * is right for JSON and would stop the SPA from loading a single byte. This is
 * the policy that replaces it on `index.html`, and only there: a policy on a
 * `.js` or `.css` response governs nothing, because CSP belongs to the document
 * that loaded them.
 */

/**
 * Bodies of the inline `<script>` elements in `html`. A `src` attribute means
 * there is no body to hash, so those are skipped and covered by `'self'`.
 */
const inlineScripts = (html: string): readonly string[] =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1] ?? '',
  );

/**
 * A `'sha256-…'` source for every inline script, which is what lets the policy
 * refuse `'unsafe-inline'` and still run the one script `index.html` carries:
 * the bootstrap that sets `lang`, `dir` and `color-scheme` before React mounts.
 * The hashes are computed from the file that is actually served, so editing that
 * script cannot leave a stale policy behind.
 */
export const inlineScriptHashes = (html: string): readonly string[] =>
  inlineScripts(html).map(
    (script) => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`,
  );

/**
 * `mediaOrigin` is the bucket's ({@link storageOrigin}). The browser talks to
 * it directly through presigned URLs: an upload is a `PUT` to it, an image or
 * thumbnail is an `<img>` from it, and a voice note is an `<audio>` from it. No
 * other origin is allowed for any of the three.
 */
export const adminContentSecurityPolicy = (html: string, mediaOrigin?: string): string => {
  const bucket = mediaOrigin === undefined ? '' : ` ${mediaOrigin}`;
  return [
    "default-src 'none'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trimEnd(),
    // Emotion writes MUI's styles into `<style>` elements at runtime. Removing
    // this means giving that cache a nonce, which is a change in `apps/admin`.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${bucket}`,
    `media-src 'self'${bucket}`,
    "font-src 'self'",
    // The api is the admin's own origin (Caddy sends the admin host to it);
    // the bucket takes the presigned upload PUTs.
    `connect-src 'self'${bucket}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
};

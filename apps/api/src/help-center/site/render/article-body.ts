import { videoEmbedUrl } from '@helpdock/schemas';
import { esc } from './text.js';

/**
 * An article's stored html, as the page draws it (M5-03).
 *
 * The body was sanitised against the article allowlist when it was saved
 * (`sanitizeArticleHtml`, ADR 0007), so this does not sanitise again; it
 * turns the two things the editor stores as data into what a reader sees:
 *
 * - a video is stored as `<div data-video="<embed address>"></div>`, never as
 *   an iframe. The iframe is built here, from the address checked against the
 *   two-player allowlist once more ({@link videoEmbedUrl}), sandboxed, lazy,
 *   and without a referrer beyond the origin;
 * - a link to another article is a path on the help center (`/en/articles/…`),
 *   which on the install's fallback path needs the brand's base in front.
 *
 * Callouts, tables and code are styled by the page's stylesheet from the
 * attributes the sanitiser kept.
 */

const VIDEO = /<div data-video="([^"]*)"><\/div>/g;
const PATH_HREF = /<a href="(\/[^"]*)"/g;

const decode = (value: string): string =>
  // `&amp;` last, so an escaped entity (`&amp;quot;`) stays the text it was.
  value.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');

export const articleBodyHtml = (
  html: string,
  options: { readonly videoTitle: string; readonly href: (path: string) => string },
): string =>
  html
    .replace(VIDEO, (_match, address: string) => {
      const embed = videoEmbedUrl(decode(address));
      if (embed === null) {
        return '';
      }
      return `<div class="hd-video"><iframe src="${esc(embed)}" title="${esc(options.videoTitle)}" loading="lazy" allow="fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe></div>`;
    })
    .replace(PATH_HREF, (_match, path: string) => `<a href="${esc(options.href(decode(path)))}"`);

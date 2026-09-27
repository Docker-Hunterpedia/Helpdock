import { CALLOUT_KINDS, HC_MEDIA_PATH_PATTERN, videoEmbedUrl } from '@helpdock/schemas';
import sanitizeHtmlLibrary from 'sanitize-html';
import { SanitizeLimitError } from './sanitize.js';
import { htmlToText } from './text.js';

/**
 * The allowlist for help center articles (M5-02, ADR 0001, ADR 0007): the
 * same library and the same stance as `sanitizeMessageHtml`, with the nodes
 * the article editor produces and nothing else.
 *
 * It runs on every write — the editor's autosave, a Markdown import (which the
 * editor turns into html before saving), and anything an API caller sends — so
 * the browser editor's own schema is a convenience and this is the boundary
 * (ADR 0001: "ProseMirror … is **not** a security boundary").
 *
 * What differs from a message, and why:
 *
 * - **Anchors.** `h2`–`h4` keep an `id` of lower-case words, and a link may be
 *   `#that-id` or a path on this help center (`/en/articles/…`). A message
 *   comes from anywhere, so relative URLs in one are refused; an article is
 *   rendered on the help center it links into.
 * - **Direction.** `dir` on blocks, because an Arabic article with an English
 *   code sample is bidirectional per block (ADR 0001).
 * - **Callouts and videos** are `div`s carrying one data attribute each. A
 *   video is stored as the *address* of an embed from an allowlist of two
 *   players ({@link videoEmbedUrl}), never as an `<iframe>`: the help center
 *   renderer builds the iframe, so no stored article can carry one.
 * - **Images** may only name this brand's own media route
 *   ({@link HC_MEDIA_PATH_PATTERN}), which redirects to a presigned URL after
 *   the pipeline has re-encoded the upload. A remote `src` is dropped.
 * - **Code** keeps a `language-*` class, which is the one class anywhere in an
 *   article, for syntax highlighting on the help center.
 */

const ARTICLE_TAGS = [
  'p',
  'br',
  'h2',
  'h3',
  'h4',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'hr',
  'table',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
  'div',
] as const;

const DIRECTION = ['dir'];

const ARTICLE_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title', 'rel', 'target'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  h2: ['id', ...DIRECTION],
  h3: ['id', ...DIRECTION],
  h4: ['id', ...DIRECTION],
  p: DIRECTION,
  li: DIRECTION,
  ul: DIRECTION,
  ol: ['start', ...DIRECTION],
  blockquote: DIRECTION,
  pre: DIRECTION,
  td: ['colspan', 'rowspan', ...DIRECTION],
  th: ['colspan', 'rowspan', 'scope', ...DIRECTION],
  div: ['data-callout', 'data-video', ...DIRECTION],
};

/** An anchor id: what the editor's "Anchor" control writes. */
const ANCHOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ANCHOR_ID_MAX = 80;
const DIRECTIONS = new Set(['ltr', 'rtl', 'auto']);
const CALLOUTS = new Set<string>(CALLOUT_KINDS);

/** Absolute with an allowed scheme, a fragment, or a path on this host (never `//host`). */
const ARTICLE_LINK = /^(?:(?:https?|mailto|tel):|#[a-z0-9-]+$|\/(?!\/))/i;

/**
 * Tags per article. Higher than a message's, because a long article with a
 * few tables is legitimately thousands of elements; still far below where the
 * library's cost in nesting depth turns (ADR 0007).
 */
export const ARTICLE_MAX_TAGS = 20_000;

const TAG_OPENING = /<[a-zA-Z]/g;

const without = (attribs: Record<string, string>, name: string): Record<string, string> => {
  const { [name]: _dropped, ...rest } = attribs;
  return rest;
};

/** Drops `dir` unless it is one of the three values it can mean. */
const withDirection = (attribs: Record<string, string>): Record<string, string> =>
  attribs.dir === undefined || DIRECTIONS.has(attribs.dir) ? attribs : without(attribs, 'dir');

const heading = (tagName: string, attribs: Record<string, string>) => {
  const id = attribs.id;
  const keepsId = id !== undefined && id.length <= ANCHOR_ID_MAX && ANCHOR_ID.test(id);

  return { tagName, attribs: withDirection(keepsId ? attribs : without(attribs, 'id')) };
};

const optionsFor = (brandId: string): sanitizeHtmlLibrary.IOptions => ({
  allowedTags: [...ARTICLE_TAGS],
  allowedAttributes: ARTICLE_ATTRIBUTES,
  allowedClasses: { code: ['language-*'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: [] },
  allowProtocolRelative: false,
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'noscript',
    'title',
    'button',
    'input',
    'select',
    'iframe',
  ],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href?.trim();
      const kept =
        href !== undefined && ARTICLE_LINK.test(href) ? attribs : without(attribs, 'href');

      return {
        tagName,
        attribs: {
          ...kept,
          rel: 'noopener noreferrer',
          ...(attribs.target === undefined ? {} : { target: '_blank' }),
        },
      };
    },
    img: (tagName, attribs) => {
      const src = attribs.src?.trim();
      const ownMedia =
        src !== undefined &&
        HC_MEDIA_PATH_PATTERN.test(src) &&
        src.startsWith(`/api/help-center/brands/${brandId}/`);

      return { tagName, attribs: ownMedia ? attribs : without(attribs, 'src') };
    },
    h2: heading,
    h3: heading,
    h4: heading,
    div: (tagName, attribs) => {
      const video =
        attribs['data-video'] === undefined ? null : videoEmbedUrl(attribs['data-video']);
      const callout = attribs['data-callout'];
      const next = withDirection(without(without(attribs, 'data-video'), 'data-callout'));

      if (video !== null) {
        return { tagName, attribs: { 'data-video': video } };
      }
      if (callout !== undefined && CALLOUTS.has(callout)) {
        return { tagName, attribs: { ...next, 'data-callout': callout } };
      }
      // A bare div is a paragraph box; keeping it as one means a callout or
      // video whose attribute was refused still keeps its text.
      return { tagName: 'div', attribs: next };
    },
    '*': (tagName, attribs) => ({ tagName, attribs: withDirection(attribs) }),
  },
  // An `<img>` without a `src` is nothing to show.
  exclusiveFilter: (frame) => frame.tag === 'img' && frame.attribs.src === undefined,
  parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
});

export interface SanitizedArticle {
  /** Safe to store and to render. */
  readonly html: string;
  /** The same article as text: search (M5-05) and chunking (M7) read this. */
  readonly text: string;
}

/**
 * The sanitised article and its text. Refuses a body built to be expensive
 * ({@link SanitizeLimitError}); never throws on malformed markup.
 */
export const sanitizeArticleHtml = (
  html: string,
  { brandId }: { brandId: string },
): SanitizedArticle => {
  const tags = html.match(TAG_OPENING)?.length ?? 0;
  if (tags > ARTICLE_MAX_TAGS) {
    throw new SanitizeLimitError(
      `That article contains more than ${ARTICLE_MAX_TAGS} HTML tags and cannot be saved`,
    );
  }

  const safe = sanitizeHtmlLibrary(html, optionsFor(brandId));

  return { html: safe, text: htmlToText(safe) };
};

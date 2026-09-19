import sanitizeHtmlLibrary from 'sanitize-html';

/**
 * The allowlist REQUIREMENTS §5.1 demands: "Email: no HTML JS/forms rendered;
 * sanitized HTML (allowlist), remote images proxied/blocked (toggle)."
 *
 * Every body that reaches `ticket_messages.body_html` goes through here, from
 * whatever channel — an agent's rich-text reply, an inbound email, a widget
 * message, the API. A body is sanitised *on the way in* and stored sanitised,
 * because a body stored raw is a body that will eventually be rendered by
 * something that forgot to sanitise it.
 *
 * The library is [ADR
 * 0007](../../../../docs/decisions/0007-html-sanitizer.md). What follows is the
 * policy on top of it; the ADR says why there is a library at all.
 */

/**
 * What survives. Deliberately smaller than the library's own defaults:
 *
 * - no `<form>`, `<input>`, `<button>`, `<iframe>`, `<object>`, `<embed>`,
 *   `<svg>`, `<math>` — none of them belong in a support thread and each is a
 *   way to run script or to phish inside one;
 * - no `<style>` and no `<link>`: a stylesheet can reposition an element over
 *   the page's own controls;
 * - `<img>` is allowed, because inline images are how screenshots and email
 *   signatures arrive, and {@link SanitizeHtmlOptions.imageSrc} decides what a
 *   `src` may be.
 */
export const ALLOWED_TAGS = [
  'p',
  'br',
  'div',
  'span',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'img',
] as const;

/**
 * No `style`, and no `on*` anywhere: an allowlist of attribute *names* is what
 * keeps `onerror` and `onload` out, whatever tag they are written on, so
 * `<svg onload>` and `<img onerror>` lose the handler even before `svg` loses
 * the element.
 *
 * `class` is allowed on nothing. Inbound email is full of classes that mean
 * something in the sender's stylesheet and nothing in ours, and a class that
 * collides with the admin's own is a way to restyle the page around the
 * message.
 */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title', 'rel', 'target'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  blockquote: ['cite'],
};

/**
 * Schemes a link may use. `javascript:`, `vbscript:` and `data:` are absent, so
 * `href="javascript:alert(1)"` loses its attribute rather than its page. The
 * library also decodes entities and strips control characters before comparing,
 * which is what defeats `java&#115;cript:` and `java\tscript:`.
 */
const ALLOWED_LINK_SCHEMES = ['http', 'https', 'mailto', 'tel'];

/** What may stand in an `<img src>`; see {@link SanitizeHtmlOptions.imageSrc}. */
export type ImageSrcPolicy =
  /** `cid:` references and http(s) URLs both survive. */
  | 'allow-remote'
  /**
   * Only `cid:` survives: a remote `src` is a read receipt the sender did not
   * ask the recipient for, and in the admin it is a request from the desk's
   * network to an address the sender chose. M2-07 turns this into a per-brand
   * toggle with a proxy behind it; until the proxy exists, blocking is the
   * default a support desk should have.
   */
  | 'cid-only';

export interface SanitizeHtmlOptions {
  /** Default `'cid-only'`. */
  readonly imageSrc?: ImageSrcPolicy;
}

/**
 * `<a>` that survives sanitising leaves with `rel="noopener noreferrer
 * nofollow"`, whatever it arrived with. `noopener` stops a target page reaching
 * back through `window.opener`; `noreferrer` stops the ticket's URL leaking to
 * whatever a customer linked; `nofollow` stops the help center being a link
 * farm for whoever emails it.
 */
const LINK_REL = 'noopener noreferrer nofollow';

const optionsFor = (imageSrc: ImageSrcPolicy): sanitizeHtmlLibrary.IOptions => ({
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: ALLOWED_LINK_SCHEMES,
  allowedSchemesByTag: {
    // `cid:` is how a MIME part refers to an attachment of the same message
    // (RFC 2392). It resolves against the message, never against the network,
    // so it is safe under either policy; M1-10 is what turns one into a
    // presigned URL at render time.
    img: imageSrc === 'allow-remote' ? ['cid', 'http', 'https'] : ['cid'],
  },
  // `//evil.example/x` inherits the page's scheme, which makes an allowlist of
  // schemes meaningless.
  allowProtocolRelative: false,
  // The content of these goes with the tag rather than being unwrapped into the
  // thread. `<script>alert(1)</script>` unwrapped would leave `alert(1)` as
  // visible text and `<style>` would leave CSS; a form control unwrapped would
  // leave its label — "Verify your account" with nothing behind it — which is
  // the phishing lure without the form. Paragraphs *inside* a `<form>` are
  // ordinary text and survive, because a newsletter wraps half its body in one.
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
  ],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        rel: LINK_REL,
        ...(attribs.target === undefined ? {} : { target: '_blank' }),
      },
    }),
  },
  // Comments can carry conditional content that a mail client acts on
  // (`<!--[if mso]>`), and nobody in a thread reads one.
  allowedIframeHostnames: [],
  parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
});

const CID_ONLY = optionsFor('cid-only');
const ALLOW_REMOTE = optionsFor('allow-remote');

/**
 * The sanitised body. Never throws on malformed input: a parser that gives up
 * on a half-closed tag would mean a message that cannot be stored, and the
 * tolerant parse of a broken document is exactly what a mail client would do
 * with it anyway.
 */
export const sanitizeMessageHtml = (
  html: string,
  { imageSrc = 'cid-only' }: SanitizeHtmlOptions = {},
): string => sanitizeHtmlLibrary(html, imageSrc === 'allow-remote' ? ALLOW_REMOTE : CID_ONLY);

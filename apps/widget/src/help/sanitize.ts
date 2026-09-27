/**
 * Article HTML is sanitised on the server (ADR 0007), but the widget runs on
 * the customer's origin, so it is rebuilt here from an allow-list before it
 * reaches the page: unknown elements are unwrapped to their text, every
 * attribute but a safe `href` is dropped, and nothing is ever assigned to
 * `innerHTML`.
 */
const ALLOWED = new Set([
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'strong',
  'em',
  'b',
  'i',
  'a',
  'code',
  'pre',
  'blockquote',
]);
const DROPPED = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript']);
const SAFE_HREF = /^(https?:|mailto:)/i;

function copy(source: Node, target: Node, document: Document): void {
  for (const child of source.childNodes) {
    if (child.nodeType === 3) {
      target.appendChild(document.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    const tag = (child as Element).tagName.toLowerCase();
    if (DROPPED.has(tag)) {
      continue;
    }
    if (!ALLOWED.has(tag)) {
      copy(child, target, document);
      continue;
    }
    const element = document.createElement(tag);
    if (tag === 'a') {
      const href = (child as Element).getAttribute('href')?.trim() ?? '';
      if (SAFE_HREF.test(href)) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
    copy(child, element, document);
    target.appendChild(element);
  }
}

export function sanitizeArticle(html: string, document: Document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const fragment = document.createDocumentFragment();
  copy(parsed.body, fragment, document);
  return fragment;
}

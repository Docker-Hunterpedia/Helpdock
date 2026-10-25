// Pagefind's static index, served from this origin. Its script loads on first
// use, never before, and once for the dialog and the 404 page together.

export type PagefindSection = { title: string; url: string; excerpt: string };
export type PagefindResult = {
  url: string;
  excerpt: string;
  meta: { title?: string };
  sub_results?: PagefindSection[];
};
type Found = { results: { data: () => Promise<PagefindResult> }[] };
type Pagefind = {
  init: () => Promise<void>;
  search: (query: string) => Promise<Found>;
  debouncedSearch: (query: string) => Promise<Found | null>;
};

const PAGEFIND = '/pagefind/pagefind.js';
let pagefind: Promise<Pagefind> | undefined;

export function loadPagefind(): Promise<Pagefind> {
  pagefind ??= import(/* @vite-ignore */ PAGEFIND).then(async (module: Pagefind) => {
    await module.init();
    return module;
  });
  return pagefind;
}

/** The icon for a result, by the section of the site it lives in. */
export function pageIcon(url: string): string {
  const path = new URL(url, location.origin).pathname.replace(/^\/ar\//, '/');
  if (path.startsWith('/docs/')) return 'book-open';
  if (path.startsWith('/features/')) return 'sparkles';
  if (path.startsWith('/channels/')) return 'message-circle';
  if (path.startsWith('/compare/') || path.startsWith('/alternatives/')) return 'scale';
  if (path.startsWith('/changelog/')) return 'history';
  return 'file-text';
}

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/** The sections of a page that are not the page itself, the best first. */
export function sectionsOf(result: PagefindResult, limit: number): PagefindSection[] {
  return (result.sub_results ?? [])
    .filter((section) => section.url !== result.url && section.title)
    .slice(0, limit);
}

export function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/** Pagefind encodes the excerpt's text and adds only <mark>, so it is safe as HTML. */
export function excerpt(html: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = 'search-excerpt';
  element.innerHTML = html;
  return element;
}

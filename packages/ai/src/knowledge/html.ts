import { load } from 'cheerio';

/**
 * HTML into the light Markdown the chunker reads (`chunker.ts`): headings
 * become `#` lines, block elements become paragraphs, and everything that is
 * not the page's content — scripts, styles, navigation, headers and footers,
 * forms — is dropped. Used for crawled pages, DOCX (through mammoth's HTML),
 * Google Docs exports and help center articles alike.
 *
 * Links are collected on the way for the crawler, resolved against the page's
 * URL; only `http` and `https` ones are kept, without their fragment.
 */

export interface HtmlText {
  readonly title: string;
  /** Markdown-ish text: `#` headings, paragraphs separated by blank lines. */
  readonly text: string;
  readonly links: readonly string[];
}

/** The structural part of a parsed node this walker needs. */
interface DomNode {
  readonly type: string;
  readonly name?: string;
  readonly data?: string;
  readonly attribs?: Readonly<Record<string, string>>;
  readonly children?: readonly DomNode[];
}

const DROPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'head',
]);

const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'li',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'tr',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'details',
  'summary',
  'address',
]);

const HEADING_LEVEL: Readonly<Record<string, number>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const resolveLink = (href: string, base: string | undefined): string | null => {
  try {
    const url = base === undefined ? new URL(href) : new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
};

export const htmlToText = (html: string, baseUrl?: string): HtmlText => {
  const $ = load(html);
  const title =
    collapse($('title').first().text()) || collapse($('h1, h2, h3, h4, h5, h6').first().text());
  const content = $('main').first().get(0) ?? $('article').first().get(0) ?? $('body').get(0);
  const root = (content ?? $.root().get(0)) as unknown as DomNode;

  const blocks: string[] = [];
  const links = new Set<string>();
  let line = '';

  const endBlock = (): void => {
    const text = collapse(line);
    if (text !== '') {
      blocks.push(text);
    }
    line = '';
  };

  const walk = (node: DomNode): void => {
    if (node.type === 'text') {
      line += node.data ?? '';
      return;
    }
    if (node.type !== 'tag' && node.type !== 'root') {
      return;
    }
    const name = node.name ?? '';
    if (DROPPED.has(name)) {
      return;
    }
    if (name === 'a' && node.attribs?.href !== undefined) {
      const link = resolveLink(node.attribs.href, baseUrl);
      if (link !== null) {
        links.add(link);
      }
    }
    const level = HEADING_LEVEL[name];
    if (level !== undefined) {
      endBlock();
      const saved = blocks.length;
      for (const child of node.children ?? []) {
        walk(child);
      }
      endBlock();
      const heading = blocks.splice(saved).join(' ');
      if (heading !== '') {
        blocks.push(`${'#'.repeat(level)} ${heading}`);
      }
      return;
    }
    if (name === 'br') {
      line += ' ';
      return;
    }
    const block = BLOCKS.has(name);
    if (block) {
      endBlock();
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
    if (block) {
      endBlock();
    } else if (name === 'td' || name === 'th') {
      line += ' ';
    }
  };

  walk(root);
  endBlock();

  return { title, text: blocks.join('\n\n'), links: [...links] };
};

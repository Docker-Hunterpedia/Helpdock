import { posix } from 'node:path';
import { REPO } from '../data/site.ts';

export const GUIDES_DIR = 'docs/guides';

export type LinkContext = {
  /** The directory of the Markdown file, relative to the repository root (`.` for the root). */
  sourceDir: string;
  /** Names of the guides the site publishes under `/docs/<name>/`. */
  publishedGuides: ReadonlySet<string>;
};

const ATTRIBUTE = /(<(?:a|img)\b[^>]*?\s(?:href|src)=")([^"]*)(")/gi;
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Where a repository-relative link should point on the website. A published
 * guide becomes `/docs/<name>/`; any other repository path becomes its page on
 * GitHub. Absolute URLs, site paths, mail links and in-page anchors are kept.
 */
export function rewriteHref(href: string, context: LinkContext): string {
  if (href === '' || href.startsWith('#') || href.startsWith('/') || ABSOLUTE.test(href)) {
    return href;
  }
  const hashAt = href.indexOf('#');
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const resolved = posix.normalize(posix.join(context.sourceDir, path));
  if (resolved === '..' || resolved.startsWith('../')) return href;

  if (posix.dirname(resolved) === GUIDES_DIR && resolved.endsWith('.md')) {
    const name = posix.basename(resolved, '.md');
    if (context.publishedGuides.has(name)) return `/docs/${name}/${hash}`;
  }
  const directory = path.endsWith('/') || resolved === '.';
  const target = resolved === '.' ? '' : resolved.replace(/\/$/, '');
  return `${REPO}/${directory ? 'tree' : 'blob'}/main/${target}${hash}`;
}

/** Rewrites the `href` of every anchor and the `src` of every image in rendered HTML. */
export function rewriteGuideLinks(html: string, context: LinkContext): string {
  return html.replace(
    ATTRIBUTE,
    (_match, before: string, value: string, after: string) =>
      `${before}${escapeAttribute(rewriteHref(value.replaceAll('&amp;', '&'), context))}${after}`,
  );
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

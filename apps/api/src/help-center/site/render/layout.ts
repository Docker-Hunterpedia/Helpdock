import type { HcLocale } from '@helpdock/schemas';
import type { SiteLinks } from '../paths.js';
import type { StaffReader } from '../staff-access.js';
import { icon } from './icons.js';
import { PAGE_CSS } from './styles.js';
import { esc, type Translate } from './text.js';

/**
 * The frame every help center page shares (DESIGN §6.7; `HelpCenter/*`): the
 * document head with its SEO tags (M5-04), the header, the footer, and the
 * two scripts a page may carry — the widget and the one line that opens it —
 * under the response's nonce.
 *
 * The html is built with {@link NONCE} where the nonce goes; `HelpCenterSite`
 * puts a fresh one in per response, so a cached page is never served with
 * the nonce of the response that rendered it.
 */

export const NONCE = '__hd_nonce__';

/** Served by `FontsController` from `packages/ui/fonts`. */
const FONTS_STYLESHEET = '/_hd/fonts/fonts.css';

export interface Alternate {
  readonly hreflang: string;
  readonly href: string;
}

export interface HeadView {
  readonly title: string;
  readonly description: string;
  /** Absolute. Null on a page that is not to be indexed. */
  readonly canonical: string | null;
  readonly alternates: readonly Alternate[];
  /** `noindex` for every state, search, staff and preview page. */
  readonly noindex: boolean;
  readonly og: {
    readonly type: 'website' | 'article';
    readonly image: string | null;
  } | null;
  readonly jsonLd: readonly object[];
}

export interface NavLink {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface ExternalLink {
  readonly label: string;
  readonly url: string;
}

export interface ChromeView {
  readonly locale: HcLocale;
  readonly t: Translate;
  readonly links: SiteLinks;
  readonly siteName: string;
  readonly brandName: string;
  /** Absolute, for OG. */
  readonly logoSrc: string | null;
  readonly faviconSrc: string | null;
  /** Categories, then the brand's header links. Empty on the state pages. */
  readonly nav: readonly NavLink[];
  readonly headerLinks: readonly ExternalLink[];
  readonly footerLinks: readonly ExternalLink[];
  readonly headerSearch: boolean;
  /** This page in the other language. */
  readonly otherLocaleHref: string;
  readonly staff: StaffReader | null;
  readonly internalOnly: boolean;
  readonly themeCss: string;
  readonly customCss: string;
  readonly mode: 'light' | 'dark' | 'auto';
  /** The widget, when the brand allows it on this origin and the page is not a preview. */
  readonly widget: { readonly brandId: string } | null;
  /** A banner above the header: the editor's preview. */
  readonly banner: string | null;
  readonly head: HeadView;
}

const OTHER_LOCALE: Readonly<Record<HcLocale, HcLocale>> = { en: 'ar', ar: 'en' };

/** JSON in a `<script>`: `<` can never close the element. */
const jsonForScript = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');

const initialOf = (name: string): string => Array.from(name.trim())[0]?.toUpperCase() ?? 'H';

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toUpperCase() ?? '')
    .join('');

const head = (view: ChromeView): string => {
  const { head: meta, locale } = view;
  const lines = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}">`,
  ];
  if (meta.noindex) {
    lines.push('<meta name="robots" content="noindex">');
  }
  if (meta.canonical !== null) {
    lines.push(`<link rel="canonical" href="${esc(meta.canonical)}">`);
  }
  for (const alternate of meta.alternates) {
    lines.push(
      `<link rel="alternate" hreflang="${esc(alternate.hreflang)}" href="${esc(alternate.href)}">`,
    );
  }
  if (meta.og !== null && meta.canonical !== null) {
    lines.push(
      `<meta property="og:type" content="${meta.og.type}">`,
      `<meta property="og:title" content="${esc(meta.title)}">`,
      `<meta property="og:description" content="${esc(meta.description)}">`,
      `<meta property="og:url" content="${esc(meta.canonical)}">`,
      `<meta property="og:site_name" content="${esc(view.siteName)}">`,
      `<meta property="og:locale" content="${locale === 'ar' ? 'ar_AR' : 'en_US'}">`,
      '<meta name="twitter:card" content="summary">',
    );
    if (meta.og.image !== null) {
      lines.push(`<meta property="og:image" content="${esc(meta.og.image)}">`);
    }
  }
  if (view.faviconSrc !== null) {
    lines.push(`<link rel="icon" href="${esc(view.faviconSrc)}">`);
  }
  lines.push(
    `<link rel="stylesheet" href="${FONTS_STYLESHEET}">`,
    `<style nonce="${NONCE}">${view.themeCss}\n${PAGE_CSS}\n${view.customCss}</style>`,
  );
  for (const data of meta.jsonLd) {
    lines.push(`<script type="application/ld+json">${jsonForScript(data)}</script>`);
  }
  return lines.join('\n');
};

const searchField = (view: ChromeView): string =>
  `<form class="hd-header-search" role="search" method="get" action="${esc(view.links.search(view.locale))}">${icon('search', 16)}<input type="search" name="q" placeholder="${esc(view.t('search.label'))}" aria-label="${esc(view.t('search.label'))}"></form>`;

const brandLink = (view: ChromeView): string => {
  const mark =
    view.logoSrc === null
      ? `<span class="hd-mark" aria-hidden="true">${esc(initialOf(view.brandName))}</span>`
      : `<img class="hd-logo" src="${esc(view.logoSrc)}" alt="">`;
  return `<a class="hd-brand" href="${esc(view.links.home(view.locale))}">${mark}<span>${esc(view.siteName)}</span></a>`;
};

const staffControls = (view: ChromeView): string => {
  if (view.staff === null) {
    return '';
  }
  return `<span class="hd-staff"><span class="hd-avatar" aria-hidden="true">${esc(initialsOf(view.staff.name))}</span><span>${esc(view.staff.name)}</span><form class="hd-inline-form" method="post" action="${esc(view.links.signOut())}"><button class="hd-icon-button" type="submit" aria-label="${esc(view.t('states.signOut'))}">${icon('logOut', 16, true)}</button></form></span>`;
};

const header = (view: ChromeView): string => {
  const other = OTHER_LOCALE[view.locale];
  const nav =
    view.nav.length + view.headerLinks.length === 0
      ? ''
      : `<nav class="hd-nav" aria-label="${esc(view.t('nav.label'))}">${view.nav
          .map(
            (link) =>
              `<a href="${esc(link.href)}"${link.current ? ' aria-current="page"' : ''}>${esc(link.label)}</a>`,
          )
          .join('')}${view.headerLinks
          .map((link) => `<a href="${esc(link.url)}" rel="noopener">${esc(link.label)}</a>`)
          .join('')}</nav>`;
  const internal = view.internalOnly
    ? `<span class="hd-label-internal">${icon('lock', 14)}${esc(view.t('states.internal'))}</span>`
    : '';
  const search = view.headerSearch ? searchField(view) : '';

  return `<header class="hd-header">
${brandLink(view)}
${nav}<span class="hd-push"></span>${search}${internal}${staffControls(view)}
<a class="hd-lang" href="${esc(view.otherLocaleHref)}" lang="${other}" hreflang="${other}" dir="${other === 'ar' ? 'rtl' : 'ltr'}">${esc(view.t('otherLanguage'))}</a>
</header>`;
};

const footer = (view: ChromeView): string => {
  const links =
    view.footerLinks.length === 0
      ? ''
      : `<nav aria-label="${esc(view.t('nav.footer'))}">${view.footerLinks
          .map((link) => `<a href="${esc(link.url)}" rel="noopener">${esc(link.label)}</a>`)
          .join('')}</nav>`;
  return `<footer class="hd-footer">
<span class="hd-footer-brand"><span class="hd-mark" aria-hidden="true">${esc(initialOf(view.brandName))}</span><bdi>${esc(view.brandName)}</bdi></span>
${links}
<span class="hd-push hd-muted">© ${String(new Date().getUTCFullYear())} <bdi>${esc(view.brandName)}</bdi></span>
</footer>`;
};

/**
 * The widget's script (M4-01) and the line that opens it from a "Chat with
 * us" button, which carries the article it was pressed on for the widget to
 * pick up (`Helpdock('open', context)`, M5-08).
 */
const widgetScripts = (view: ChromeView): string => {
  if (view.widget === null) {
    return '';
  }
  const opener =
    'window.Helpdock=window.Helpdock||function(){(Helpdock.q=Helpdock.q||[]).push(arguments)};' +
    "document.querySelectorAll('[data-hd-chat]').forEach(function(b){b.addEventListener('click',function(){var c=b.getAttribute('data-hd-chat');Helpdock('open',c?JSON.parse(c):null)})});";
  return `<script type="module" src="/widget.js" data-brand="${esc(view.widget.brandId)}" data-locale="${view.locale}" nonce="${NONCE}"></script>
<script nonce="${NONCE}">${opener}</script>`;
};

export const renderDocument = (view: ChromeView, main: string): string => {
  const theme = view.mode === 'auto' ? '' : ` data-theme="${view.mode}"`;
  return `<!doctype html>
<html lang="${view.locale}" dir="${view.locale === 'ar' ? 'rtl' : 'ltr'}"${theme}>
<head>
${head(view)}
</head>
<body>
${view.banner ?? ''}
${header(view)}
${main}
${footer(view)}
${widgetScripts(view)}
</body>
</html>`;
};

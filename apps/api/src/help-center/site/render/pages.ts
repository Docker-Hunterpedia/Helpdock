import { HC_FEEDBACK_COMMENT_MAX, type HcLocale } from '@helpdock/schemas';
import { FEEDBACK_TARGET, type FeedbackStep } from '../feedback-step.js';
import { icon } from './icons.js';
import type { NavLink } from './layout.js';
import { esc, inLanguage, type Translate } from './text.js';

/**
 * The `<main>` of each help center page (M5-03; `HelpCenter/Home-EN|AR`,
 * `Category-EN|AR`, `Help center · article`, `Article-AR`, `Search-EN|AR`,
 * `States-EN`), from view models `HelpCenterSite` builds. Plain semantic html
 * that reads without script (DESIGN §6.7); every value from outside goes
 * through `esc`.
 */

export interface ListItem {
  readonly title: string;
  /** The article's language, which differs from the page's on a fallback. */
  readonly lang: HcLocale;
  readonly href: string;
  /** Caption at the inline end: the section or category. */
  readonly meta?: string;
  /** Staff only: the article is not public. */
  readonly internal?: boolean;
}

export interface Crumb {
  readonly label: string;
  /** Null for the current page. */
  readonly href: string | null;
  readonly lang?: HcLocale;
}

export interface HelpView {
  /** The web form (M4-09). */
  readonly contactHref: string;
  /** The widget's open context as JSON, or null when the widget is not on this page. */
  readonly chat: string | null;
  /** The editor's preview: the buttons are drawn off, and say so. */
  readonly preview: boolean;
}

interface PageText {
  readonly t: Translate;
  readonly locale: HcLocale;
}

// ---------------------------------------------------------------- pieces

const internalBadge = (t: Translate): string =>
  `<span class="hd-badge">${icon('lock', 14)}${esc(t('article.internal'))}</span>`;

const listRows = (items: readonly ListItem[], page: PageText, lead: 'file' | 'rank'): string =>
  items
    .map(
      (item, index) =>
        `<li>${lead === 'rank' ? `<span class="hd-rank" aria-hidden="true">${String(index + 1)}</span>` : icon('file', 16)}<a href="${esc(item.href)}">${inLanguage(item.title, item.lang, page.locale)}</a>${item.internal === true ? internalBadge(page.t) : ''}${item.meta === undefined ? '' : `<span class="hd-caption">${esc(item.meta)}</span>`}</li>`,
    )
    .join('');

export const breadcrumb = (crumbs: readonly Crumb[], page: PageText): string =>
  `<nav class="hd-breadcrumb" aria-label="${esc(page.t('nav.breadcrumb'))}"><ol>${crumbs
    .map((crumb, index) => {
      const label = inLanguage(crumb.label, crumb.lang ?? page.locale, page.locale);
      const item =
        crumb.href === null
          ? `<span aria-current="page">${label}</span>`
          : `<a href="${esc(crumb.href)}">${label}</a>`;
      return `<li>${index === 0 ? '' : icon('chevron', 14, true)}${item}</li>`;
    })
    .join('')}</ol></nav>`;

const chatButton = (help: HelpView, t: Translate, withIcon: boolean): string => {
  if (help.preview) {
    return `<button class="hd-button" type="button" disabled>${withIcon ? icon('message') : ''}${esc(t('help.chat'))}</button>`;
  }
  return help.chat === null
    ? ''
    : `<button class="hd-button" type="button" data-hd-chat="${esc(help.chat)}">${withIcon ? icon('message') : ''}${esc(t('help.chat'))}</button>`;
};

/** "Still need help?" across the page: home and a search with no results. */
export const helpBanner = (help: HelpView, page: PageText, bodyKey: string): string => {
  const { t } = page;
  return `<section class="hd-help" aria-labelledby="hd-help-h">
<span class="hd-tile" aria-hidden="true">${icon('message', 20)}</span>
<div class="hd-help-text"><h2 class="hd-h2" id="hd-help-h">${esc(t('help.heading'))}</h2><p>${esc(t(bodyKey))}</p></div>
<a class="hd-button-secondary" href="${esc(help.contactHref)}">${icon('mail')}${esc(t('help.message'))}</a>${chatButton(help, t, true)}
</section>`;
};

/** "Still need help?" in the end column: category, section and article. */
export const helpAside = (help: HelpView, page: PageText, bodyKey: string): string => {
  const { t } = page;
  const off = help.preview ? `<p>${esc(t('help.offInPreview'))}</p>` : '';
  const message = help.preview
    ? ''
    : help.chat === null
      ? `<a class="hd-button" href="${esc(help.contactHref)}">${esc(t('help.message'))}</a>`
      : `<a href="${esc(help.contactHref)}">${esc(t('help.message'))}</a>`;
  return `<div class="hd-aside-card"><h2 class="hd-h3">${esc(t('help.heading'))}</h2><p>${esc(t(bodyKey))}</p>${chatButton(help, t, false)}${message}${off}</div>`;
};

export const searchForm = (
  page: PageText,
  options: { action: string; value: string; clearHref: string | null; large: boolean; id: string },
): string => {
  const { t } = page;
  const clear =
    options.clearHref === null || options.value === ''
      ? ''
      : `<a class="hd-clear" href="${esc(options.clearHref)}" aria-label="${esc(t('search.clear'))}">${icon('x', 16)}</a>`;
  return `<form class="hd-search" role="search" method="get" action="${esc(options.action)}">
<label class="hd-search-field" for="${options.id}">${icon('search', 20)}<input id="${options.id}" type="search" name="q" value="${esc(options.value)}" placeholder="${esc(t('search.label'))}" aria-label="${esc(t('search.label'))}">${clear}</label>
<button class="hd-button hd-button-lg" type="submit">${esc(t('search.submit'))}</button>
</form>`;
};

// ---------------------------------------------------------------- home

export interface CategoryCard {
  readonly name: string;
  readonly description: string;
  readonly href: string;
  readonly sections: number;
  readonly articles: number;
}

export interface HomeView extends PageText {
  readonly searchAction: string;
  readonly categories: readonly CategoryCard[] | null;
  readonly featured: readonly ListItem[] | null;
  readonly popular: readonly ListItem[] | null;
  readonly help: HelpView;
}

export const homeMain = (view: HomeView): string => {
  const { t } = view;
  const cards =
    view.categories === null
      ? ''
      : view.categories.length === 0
        ? `<p class="hd-lead">${esc(t('home.empty'))}</p>`
        : `<section class="hd-stack" aria-labelledby="hd-cats-h"><h2 class="hd-h2" id="hd-cats-h">${esc(t('home.browse'))}</h2><div class="hd-cards">${view.categories
            .map(
              (card) =>
                `<a class="hd-card" href="${esc(card.href)}"><span class="hd-card-title"><span class="hd-tile" aria-hidden="true">${icon('folder', 18)}</span><span>${esc(card.name)}</span></span>${card.description === '' ? '' : `<span class="hd-card-text">${esc(card.description)}</span>`}<span class="hd-caption">${esc(t('counts.sections', { count: card.sections }))} · ${esc(t('counts.articles', { count: card.articles }))}</span></a>`,
            )
            .join('')}</div></section>`;
  const lists = [
    view.featured === null || view.featured.length === 0
      ? ''
      : `<section class="hd-stack" aria-labelledby="hd-feat-h"><h2 class="hd-h2" id="hd-feat-h">${esc(t('home.featured'))}</h2><ul class="hd-list">${listRows(view.featured, view, 'file')}</ul></section>`,
    view.popular === null || view.popular.length === 0
      ? ''
      : `<section class="hd-stack" aria-labelledby="hd-pop-h"><h2 class="hd-h2" id="hd-pop-h">${esc(t('home.popular'))}</h2><ol class="hd-list">${listRows(view.popular, view, 'rank')}</ol></section>`,
  ].filter((part) => part !== '');

  return `<section class="hd-hero" aria-labelledby="hd-hero-h">
<h1 class="hd-display" id="hd-hero-h">${esc(t('home.title'))}</h1>
<p class="hd-lead">${esc(t('home.intro'))}</p>
${searchForm(view, { action: view.searchAction, value: '', clearHref: null, large: true, id: 'hd-q' })}
</section>
<main class="hd-main" id="hd-main" tabindex="-1">
${cards}
${lists.length === 0 ? '' : `<div class="hd-cards hd-cards-2">${lists.join('')}</div>`}
${helpBanner(view.help, view, 'help.body')}
</main>`;
};

// ---------------------------------------------------------------- category and section

export interface SectionCard {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly articles: readonly ListItem[];
  /** Readable articles in the section; more than are listed on a category page. */
  readonly total: number;
}

export interface CategoryView extends PageText {
  readonly crumbs: readonly Crumb[];
  readonly title: string;
  readonly description: string;
  readonly meta: string;
  readonly sections: readonly SectionCard[];
  /** A section page: one card, with its heading not repeated. */
  readonly single: boolean;
  readonly otherTopics: readonly NavLink[];
  readonly help: HelpView;
}

const sectionCard = (card: SectionCard, view: CategoryView, index: number): string => {
  const { t } = view;
  const more =
    card.total > card.articles.length
      ? `<a class="hd-more" href="${esc(card.href)}">${esc(t('category.seeAll', { count: card.total }))}${icon('chevron', 14, true)}</a>`
      : '';
  const heading = view.single
    ? ''
    : `<div class="hd-row"><h2 class="hd-h2 hd-grow" id="hd-sec-${String(index)}"><a class="hd-plain-link" href="${esc(card.href)}">${esc(card.name)}</a></h2><span class="hd-caption">${esc(t('counts.articles', { count: card.total }))}</span></div>`;
  const rows = card.articles
    .map(
      (item) =>
        `<li>${icon('file', 16)}<a href="${esc(item.href)}">${inLanguage(item.title, item.lang, view.locale)}</a>${item.internal === true ? internalBadge(t) : ''}</li>`,
    )
    .join('');
  const label = view.single
    ? `aria-label="${esc(card.name)}"`
    : `aria-labelledby="hd-sec-${String(index)}"`;
  return `<section class="hd-card" ${label}>${heading}<ul class="hd-plain-list">${rows}</ul>${more}</section>`;
};

export const categoryMain = (view: CategoryView): string => {
  const { t } = view;
  const topics =
    view.otherTopics.length === 0
      ? ''
      : `<nav class="hd-side-nav" aria-labelledby="hd-oth-h"><div class="hd-side-heading" id="hd-oth-h">${esc(t('nav.otherTopics'))}</div>${view.otherTopics
          .map((link) => `<a href="${esc(link.href)}">${esc(link.label)}</a>`)
          .join('')}</nav>`;
  return `<div class="hd-page hd-page-2">
<main class="hd-stack-lg" id="hd-main" tabindex="-1">
<div class="hd-stack hd-gap-12">
${breadcrumb(view.crumbs, view)}
<div class="hd-row hd-row-center"><span class="hd-tile hd-tile-lg" aria-hidden="true">${icon('folder', 24)}</span><h1 class="hd-display">${esc(view.title)}</h1></div>
${view.description === '' ? '' : `<p class="hd-lead">${esc(view.description)}</p>`}
<div class="hd-caption">${esc(view.meta)}</div>
</div>
<div class="hd-cards ${view.single ? 'hd-cards-1' : 'hd-cards-2'}">${view.sections.map((card, index) => sectionCard(card, view, index)).join('')}</div>
</main>
<aside class="hd-aside hd-offset-32">
${helpAside(view.help, view, 'help.articleBody')}
${topics}
</aside>
</div>`;
};

// ---------------------------------------------------------------- article

export interface FeedbackView {
  readonly action: string;
  readonly articleId: string;
  readonly locale: HcLocale;
  readonly slug: string;
  readonly step: FeedbackStep;
  /** "Skip" on the comment step: the thanks, without sending anything more. */
  readonly skipHref: string;
}

export interface ArticleView extends PageText {
  readonly crumbs: readonly Crumb[];
  readonly title: string;
  /** The text's language; differs from the page's on a fallback. */
  readonly lang: HcLocale;
  readonly meta: readonly string[];
  readonly fallback: {
    readonly title: string;
    readonly body: string;
    readonly browseHref: string;
  } | null;
  readonly bodyHtml: string;
  readonly internal: boolean;
  readonly sectionName: string;
  readonly sectionNav: readonly NavLink[];
  readonly related: readonly ListItem[];
  /** Null in a preview, where feedback is off. */
  readonly feedback: FeedbackView | null;
  readonly help: HelpView;
}

const feedbackButtons = (t: Translate, pressed: 'no' | null): string => {
  const state = (answer: 'yes' | 'no') =>
    pressed === null ? '' : ` aria-pressed="${String(answer === pressed)}"`;
  return `<fieldset><legend>${esc(t('article.feedback.question'))}</legend>
<button class="hd-button-secondary" type="submit" name="helpful" value="yes"${state('yes')}>${icon('thumbsUp')}${esc(t('article.feedback.yes'))}</button>
<button class="hd-button-secondary" type="submit" name="helpful" value="no"${state('no')}>${icon('thumbsDown')}${esc(t('article.feedback.no'))}</button>
</fieldset>`;
};

/**
 * "Was this helpful?" (`Help center · article`, `HelpCenter/Article-AR`
 * panels 2 and 3). A "Yes" goes straight to the thanks; a "No" is recorded
 * and opens the optional "What was missing?", whose Send records it again
 * with the note and whose Skip only moves on.
 */
const feedbackCard = (feedback: FeedbackView, t: Translate): string => {
  if (feedback.step === 'thanks') {
    return `<div class="hd-feedback hd-feedback-done" id="${FEEDBACK_TARGET.thanks}" role="status" tabindex="-1">${icon('check', 16)}<span><strong>${esc(t('article.feedback.thanks'))}</strong> ${esc(t('article.feedback.thanksBody'))}</span></div>`;
  }
  const hidden = `<input type="hidden" name="article" value="${esc(feedback.articleId)}">
<input type="hidden" name="locale" value="${feedback.locale}">
<input type="hidden" name="slug" value="${esc(feedback.slug)}">`;
  if (feedback.step === 'ask') {
    return `<form class="hd-feedback" id="feedback" method="post" action="${esc(feedback.action)}">
${hidden}
${feedbackButtons(t, null)}
</form>`;
  }
  return `<form class="hd-feedback hd-feedback-comment" id="feedback" method="post" action="${esc(feedback.action)}">
${hidden}
${feedbackButtons(t, 'no')}
<label class="hd-feedback-label" for="${FEEDBACK_TARGET.comment}">${esc(t('article.feedback.missing'))} <span class="hd-muted">${esc(t('article.feedback.optional'))}</span></label>
<textarea id="${FEEDBACK_TARGET.comment}" name="comment" rows="3" maxlength="${String(HC_FEEDBACK_COMMENT_MAX)}" aria-describedby="hd-feedback-hint"></textarea>
<div class="hd-feedback-actions"><span class="hd-caption" id="hd-feedback-hint">${esc(t('article.feedback.hint'))}</span><a class="hd-button-ghost" href="${esc(feedback.skipHref)}">${esc(t('article.feedback.skip'))}</a><button class="hd-button" type="submit" name="helpful" value="no">${esc(t('article.feedback.send'))}</button></div>
</form>`;
};

export const articleMain = (view: ArticleView): string => {
  const { t } = view;
  const textDir = view.lang === 'ar' ? 'rtl' : 'ltr';
  const langAttributes = view.lang === view.locale ? '' : ` lang="${view.lang}" dir="${textDir}"`;
  const note =
    view.fallback === null
      ? ''
      : `<div class="hd-note" role="note">${icon('info', 16)}<div class="hd-note-body"><strong>${esc(view.fallback.title)}</strong><span>${esc(view.fallback.body)} <a href="${esc(view.fallback.browseHref)}">${esc(t('article.fallback.browse'))}</a></span></div></div>`;
  const nav = `<nav class="hd-side-nav" aria-label="${esc(t('nav.inSection'))}"><div class="hd-side-heading" aria-hidden="true">${esc(view.sectionName)}</div>${view.sectionNav
    .map(
      (link) =>
        `<a href="${esc(link.href)}"${link.current ? ' aria-current="page"' : ''}>${esc(link.label)}</a>`,
    )
    .join('')}</nav>`;
  const related =
    view.related.length === 0
      ? ''
      : `<nav class="hd-side-nav" aria-labelledby="hd-rel-h"><div class="hd-side-heading" id="hd-rel-h">${esc(t('article.related'))}</div>${view.related
          .map(
            (item) =>
              `<a class="hd-link" href="${esc(item.href)}">${inLanguage(item.title, item.lang, view.locale)}</a>`,
          )
          .join('')}</nav>`;
  const meta = view.meta
    .map((part) => `<span>${esc(part)}</span>`)
    .join('<span class="hd-dot" aria-hidden="true"></span>');

  return `<div class="hd-page hd-page-3">
${nav}
<main class="hd-article" id="hd-main" tabindex="-1">
${note}
${breadcrumb(view.crumbs, view)}
<article class="hd-stack hd-gap-20"${langAttributes}>
<h1 class="hd-display">${esc(view.title)}</h1>
<div class="hd-meta">${meta}${view.internal ? `<span class="hd-dot" aria-hidden="true"></span>${internalBadge(t)}` : ''}</div>
<div class="hd-body">${view.bodyHtml}</div>
</article>
${view.feedback === null ? '' : feedbackCard(view.feedback, t)}
</main>
<aside class="hd-aside hd-gap-16">
${helpAside(view.help, view, 'help.articleBody')}
${related}
</aside>
</div>`;
};

// ---------------------------------------------------------------- search

export interface SearchResultView {
  readonly title: string;
  readonly lang: HcLocale;
  readonly href: string;
  /** Already escaped, with the matches in `<mark>`. */
  readonly titleHtml: string;
  readonly snippetHtml: string;
  readonly trail: readonly string[];
}

export interface SearchView extends PageText {
  readonly q: string;
  readonly action: string;
  readonly clearHref: string;
  readonly results: readonly SearchResultView[];
  readonly total: number;
  readonly language: string;
  readonly filters: readonly (NavLink & { readonly count: number })[];
  readonly topics: readonly NavLink[];
  readonly help: HelpView;
}

const highlightable = /[\p{L}\p{N}]+/gu;

/** `text`, escaped, with every word of the query marked. */
export const highlight = (text: string, query: string): string => {
  const terms = [...new Set(query.toLowerCase().match(highlightable) ?? [])].filter(
    (term) => term.length > 1,
  );
  if (terms.length === 0) {
    return esc(text);
  }
  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'giu',
  );
  return text
    .split(pattern)
    .map((part, index) => (index % 2 === 1 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join('');
};

export const searchMain = (view: SearchView): string => {
  const { t } = view;
  const form = searchForm(view, {
    action: view.action,
    value: view.q,
    clearHref: view.clearHref,
    large: true,
    id: 'hd-sq',
  });

  if (view.q === '') {
    return `<main class="hd-main hd-gap-16" id="hd-main" tabindex="-1"><h1 class="hd-display">${esc(t('search.title'))}</h1>${form}<p class="hd-status">${esc(t('search.prompt'))}</p></main>`;
  }

  if (view.results.length === 0) {
    const chips = view.topics
      .map((topic) => `<a class="hd-chip" href="${esc(topic.href)}">${esc(topic.label)}</a>`)
      .join('');
    return `<main class="hd-main hd-gap-24" id="hd-main" tabindex="-1">
<h1 class="hd-display">${esc(t('search.title'))}</h1>
${form}
<div class="hd-empty"><span class="hd-tile hd-tile-lg" aria-hidden="true">${icon('search', 24)}</span><div class="hd-stack hd-gap-4">
<div role="status"><h2 class="hd-h2">${esc(t('search.empty.heading', { q: view.q }))}</h2></div>
<p class="hd-lead">${esc(t('search.empty.body'))}</p>
${chips === '' ? '' : `<div class="hd-chips"><span>${esc(t('search.empty.browse'))}</span>${chips}</div>`}
</div></div>
${helpBanner(view.help, view, 'help.searchBody')}
</main>`;
  }

  const rows = view.results
    .map(
      (result) =>
        `<li><div class="hd-trail">${result.trail.map((part) => esc(part)).join(icon('chevron', 14, true))}</div><h2${result.lang === view.locale ? '' : ` lang="${result.lang}"`}><a href="${esc(result.href)}">${result.titleHtml}</a></h2><p${result.lang === view.locale ? '' : ` lang="${result.lang}"`}>${result.snippetHtml}</p></li>`,
    )
    .join('');
  const filters =
    view.filters.length === 0
      ? ''
      : `<nav class="hd-side-nav" aria-labelledby="hd-flt-h"><div class="hd-side-heading" id="hd-flt-h">${esc(t('search.filter'))}</div>${view.filters
          .map(
            (filter) =>
              `<a href="${esc(filter.href)}"${filter.current ? ' aria-current="true"' : ''}><span class="hd-grow">${esc(filter.label)}</span><span class="hd-count">${String(filter.count)}</span></a>`,
          )
          .join('')}</nav>`;

  return `<div class="hd-page hd-page-2">
<main class="hd-stack" id="hd-main" tabindex="-1">
<h1 class="hd-display">${esc(t('search.title'))}</h1>
${form}
<p class="hd-caption" role="status">${esc(t('search.count', { count: view.total, language: view.language }))}</p>
<ol class="hd-results">${rows}</ol>
</main>
<aside class="hd-aside hd-offset-64">${filters}</aside>
</div>`;
};

// ---------------------------------------------------------------- states

export interface NotFoundView extends PageText {
  readonly searchAction: string;
  readonly homeHref: string;
  readonly popular: readonly ListItem[];
}

export const notFoundMain = (view: NotFoundView): string => {
  const { t } = view;
  const popular =
    view.popular.length === 0
      ? ''
      : `<span class="hd-muted">${esc(t('states.notFound.popular'))} ${view.popular
          .map(
            (item) =>
              `<a href="${esc(item.href)}">${inLanguage(item.title, item.lang, view.locale)}</a>`,
          )
          .join(' · ')}</span>`;
  return `<main class="hd-state" id="hd-main" tabindex="-1">
<span class="hd-tile hd-tile-lg" aria-hidden="true">${icon('alert', 24)}</span>
<div class="hd-stack hd-gap-8"><h1 class="hd-display">${esc(t('states.notFound.heading'))}</h1><p class="hd-lead">${esc(t('states.notFound.body'))}</p></div>
${searchForm(view, { action: view.searchAction, value: '', clearHref: null, large: false, id: 'hd-nq' })}
<div class="hd-state-links"><a href="${esc(view.homeHref)}">${esc(t('states.notFound.home'))}${icon('chevron', 14, true)}</a>${popular}</div>
</main>`;
};

export interface GoneView extends PageText {
  readonly searchAction: string;
  /** What the archived article was, when the audience may know. */
  readonly article: {
    readonly title: string;
    readonly date: string;
    readonly sectionName: string;
  } | null;
  readonly more: readonly ListItem[];
}

export const goneMain = (view: GoneView): string => {
  const { t } = view;
  const body =
    view.article === null
      ? ''
      : `<p class="hd-lead">${esc(t('states.gone.body', { title: view.article.title, date: view.article.date }))}</p>`;
  const more =
    view.article === null || view.more.length === 0
      ? ''
      : `<nav class="hd-side-nav" aria-labelledby="hd-more-h"><div class="hd-side-heading" id="hd-more-h">${esc(t('states.gone.more', { section: view.article.sectionName }))}</div>${view.more
          .map(
            (item) =>
              `<a class="hd-link" href="${esc(item.href)}">${inLanguage(item.title, item.lang, view.locale)}</a>`,
          )
          .join('')}</nav>`;
  return `<main class="hd-state" id="hd-main" tabindex="-1">
<span class="hd-tile hd-tile-lg" aria-hidden="true">${icon('archive', 24)}</span>
<div class="hd-stack hd-gap-8"><h1 class="hd-display">${esc(t('states.gone.heading'))}</h1>${body}</div>
${more}
${searchForm(view, { action: view.searchAction, value: '', clearHref: null, large: false, id: 'hd-gq' })}
</main>`;
};

export interface WallView extends PageText {
  readonly brandName: string;
  readonly signInHref: string;
}

export const wallMain = (view: WallView): string => {
  const { t } = view;
  return `<main class="hd-state" id="hd-main" tabindex="-1">
<span class="hd-tile hd-tile-lg" aria-hidden="true">${icon('lock', 24)}</span>
<div class="hd-stack hd-gap-8"><h1 class="hd-display">${esc(t('states.wall.heading'))}</h1><p class="hd-lead">${esc(t('states.wall.body', { brand: view.brandName }))}</p></div>
<a class="hd-button hd-button-lg" href="${esc(view.signInHref)}">${icon('lock')}${esc(t('states.wall.button'))}</a>
<p class="hd-caption">${esc(t('states.wall.note'))}</p>
</main>`;
};

// ---------------------------------------------------------------- the preview banner

export interface PreviewBannerView extends PageText {
  readonly state: 'draft' | 'scheduled' | 'changes' | 'archived' | 'published';
  readonly date: string | null;
  readonly editHref: string;
  readonly exitHref: string;
}

export const previewBanner = (view: PreviewBannerView): string => {
  const { t } = view;
  const tone = view.state === 'scheduled' ? ' hd-preview-info' : '';
  return `<div class="hd-preview${tone}" role="region" aria-label="${esc(t('preview.label'))}">${icon(view.state === 'scheduled' ? 'calendar' : 'eye')}<span><strong>${esc(t(`preview.${view.state}.title`))}</strong> · ${esc(t(`preview.${view.state}.body`, { date: view.date ?? '' }))}</span><a href="${esc(view.editHref)}">${icon('pencil', 14)}${esc(t('preview.edit'))}</a><a href="${esc(view.exitHref)}">${icon('x', 14)}${esc(t('preview.exit'))}</a></div>`;
};

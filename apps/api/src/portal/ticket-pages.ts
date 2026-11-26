import type { HcLocale } from '@helpdock/schemas';
import { icon } from '../help-center/site/render/icons.js';
import { esc, formatDate, type Translate } from '../help-center/site/render/text.js';
import { plainTextToHtml } from '../widget/plain-text.js';
import { formatAgo, formatMessageTime } from './portal-format.js';
import { heading } from './portal-pages.js';
import type { ListScope, ListState } from './ticket-list-rules.js';
import type {
  PortalAuthor,
  PortalMessage,
  PortalOpenedBy,
  PortalTicket,
  PortalTicketList,
  PortalTicketRow,
} from './ticket-views.js';

/**
 * The ticket list and the ticket page (M21-03, artboards
 * `HelpCenter/Portal-Tickets` and `HelpCenter/Portal-Ticket`, the read side
 * only). They draw the allow-listed shapes of `ticket-views.ts` and nothing
 * else, so there is no field here to leak. Every string the shapes carry goes
 * through `esc`; a message body goes through `plainTextToHtml`, which escapes it.
 *
 * Reply, Attach files, Mark as solved, the rating and New ticket are M21-04's:
 * where the board draws them these pages draw nothing.
 */

const SEARCH_ICON = icon('search', 16);

export interface ListView {
  readonly t: Translate;
  readonly locale: HcLocale;
  readonly timeZone: string;
  readonly now: Date;
  /** The list's own address, below the help center's base. */
  readonly listPath: string;
  readonly ticketPath: (reference: string) => string;
  /** The account's name, when the customer may switch to the company's tickets. */
  readonly company: string | null;
  readonly scope: ListScope;
  readonly state: ListState;
  readonly q: string;
  readonly list: PortalTicketList;
  readonly notice: 'all' | 'manager' | null;
}

const listHref = (
  view: Pick<ListView, 'listPath' | 'locale'>,
  next: { scope: ListScope; state: ListState; q?: string; cursor?: string },
): string => {
  const params = new URLSearchParams({ lang: view.locale });
  if (next.scope === 'company') {
    params.set('scope', 'company');
  }
  if (next.state === 'solved') {
    params.set('state', 'solved');
  }
  if (next.q !== undefined && next.q !== '') {
    params.set('q', next.q);
  }
  if (next.cursor !== undefined) {
    params.set('cursor', next.cursor);
  }
  return `${view.listPath}?${params.toString()}`;
};

const countText = (count: number): string => (count >= 100 ? '99+' : String(count));

const switchLink = (href: string, current: boolean, label: string, count?: number): string =>
  `<a class="hd-pt-seg" href="${esc(href)}"${current ? ' aria-current="true"' : ''}>${esc(label)}${count === undefined ? '' : `<span class="hd-pt-count">${esc(countText(count))}</span>`}</a>`;

const openedByText = (t: Translate, openedBy: PortalOpenedBy): string =>
  openedBy.kind === 'you'
    ? t('portal.list.openedByYou')
    : openedBy.kind === 'person'
      ? t('portal.list.openedBy', { name: openedBy.name })
      : t('portal.list.openedByUnknown');

const row = (view: ListView, entry: PortalTicketRow): string => {
  const { t } = view;
  const opened =
    entry.openedBy === null ? '' : `<span>${esc(openedByText(t, entry.openedBy))}</span>`;
  const only = entry.onlyYou
    ? `<span class="hd-pt-only">${icon('lock', 12)}${esc(t('portal.list.onlyYou'))}</span>`
    : '';
  const updated = t('portal.list.updated', {
    when: formatAgo(new Date(entry.updatedAt), view.now, view.locale, view.timeZone),
  });
  return `<li><a class="hd-pt-row" href="${esc(view.ticketPath(entry.reference))}"><span class="hd-pt-main"><span class="hd-pt-subject" dir="auto">${esc(entry.subject)}</span><span class="hd-pt-sub"><span class="hd-pt-ref" dir="ltr">${esc(entry.reference)}</span>${opened}${only}<span>${esc(updated)}</span></span></span>${pill(t, entry.status)}</a></li>`;
};

const pill = (t: Translate, status: PortalTicketRow['status']): string =>
  `<span class="hd-pt-pill hd-pt-pill-${status}">${esc(t(`portal.status.${status}`))}</span>`;

const empty = (view: ListView): string => {
  const { t } = view;
  const [title, body] =
    view.q !== ''
      ? [t('portal.list.emptySearchTitle', { q: view.q }), t('portal.list.emptySearchBody')]
      : view.state === 'solved'
        ? [t('portal.list.emptySolvedTitle'), t('portal.list.emptySolvedBody')]
        : [t('portal.list.emptyOpenTitle'), t('portal.list.emptyOpenBody')];
  return `<section class="hd-pt-empty"><span class="hd-tile" aria-hidden="true">${icon('ticket', 20)}</span><h2 class="hd-pt-empty-title">${esc(title)}</h2><p class="hd-pt-empty-body">${esc(body)}</p></section>`;
};

export const ticketListMain = (view: ListView): string => {
  const { t, list } = view;
  const scopes =
    view.company === null
      ? ''
      : `<div class="hd-pt-switch" role="group" aria-label="${esc(t('portal.list.scopeLabel'))}">${switchLink(listHref(view, { scope: 'mine', state: view.state, q: view.q }), view.scope === 'mine', t('portal.list.mine'), list.counts.mine)}${switchLink(listHref(view, { scope: 'company', state: view.state, q: view.q }), view.scope === 'company', view.company, list.counts.company ?? 0)}</div>`;
  const states = `<div class="hd-pt-switch" role="group" aria-label="${esc(t('portal.list.stateLabel'))}">${switchLink(listHref(view, { scope: view.scope, state: 'open', q: view.q }), view.state === 'open', t('portal.list.open'))}${switchLink(listHref(view, { scope: view.scope, state: 'solved', q: view.q }), view.state === 'solved', t('portal.list.solved'))}</div>`;
  const hidden = [
    `<input type="hidden" name="lang" value="${view.locale}">`,
    view.scope === 'company' ? '<input type="hidden" name="scope" value="company">' : '',
    view.state === 'solved' ? '<input type="hidden" name="state" value="solved">' : '',
  ].join('');
  const search = `<form class="hd-pt-search" role="search" method="get" action="${esc(view.listPath)}">${hidden}<label class="hd-pt-field">${SEARCH_ICON}<input type="search" name="q" maxlength="100" aria-label="${esc(t('portal.list.searchLabel'))}" placeholder="${esc(t('portal.list.searchPlaceholder'))}" value="${esc(view.q)}"></label></form>`;
  const notice =
    view.notice === null || view.company === null
      ? ''
      : `<div class="hd-pt-notice" role="status">${icon('info', 16)}<span>${esc(t(view.notice === 'all' ? 'portal.list.noticeAll' : 'portal.list.noticeManager', { company: view.company }))}</span></div>`;
  const more =
    list.nextCursor === null
      ? ''
      : `<div class="hd-pt-more"><a class="hd-button-secondary" href="${esc(listHref(view, { scope: view.scope, state: view.state, q: view.q, cursor: list.nextCursor }))}">${esc(t('portal.list.showMore'))}</a></div>`;
  const rows =
    list.rows.length === 0
      ? empty(view)
      : `<ul class="hd-pt-list" aria-label="${esc(t('portal.list.listLabel'))}">${list.rows.map((entry) => row(view, entry)).join('')}</ul>${more}`;
  return `<main class="hd-portal-page" id="hd-main" tabindex="-1"><div class="hd-pt-head">${heading(t('portal.nav.tickets'))}</div><div class="hd-pt-bar">${scopes}${states}${search}</div>${notice}${rows}</main>`;
};

// ---------------------------------------------------------------- one ticket

export interface TicketView {
  readonly t: Translate;
  readonly locale: HcLocale;
  readonly timeZone: string;
  readonly brandName: string;
  readonly listHref: string;
  readonly attachmentPath: (reference: string, attachmentId: string) => string;
  readonly ticket: PortalTicket;
}

const authorLine = (
  view: TicketView,
  author: PortalAuthor,
): { name: string; tag: string | null } => {
  const { t } = view;
  switch (author.kind) {
    case 'you':
      return { name: t('portal.ticket.you'), tag: null };
    case 'coworker':
      return { name: author.name, tag: t('portal.ticket.coworker') };
    case 'other':
      return { name: author.name ?? t('portal.ticket.someone'), tag: null };
    case 'staff':
      return {
        name: t('portal.ticket.from', { name: author.name, brand: view.brandName }),
        tag: t('portal.ticket.support'),
      };
    case 'brand':
      return { name: view.brandName, tag: t('portal.ticket.support') };
  }
};

const FILE_ICON = icon('file', 14);

const message = (view: TicketView, entry: PortalMessage): string => {
  const { t } = view;
  const who = authorLine(view, entry.author);
  const time = formatMessageTime(new Date(entry.at), view.locale, view.timeZone);
  const team = entry.author.kind === 'staff' || entry.author.kind === 'brand';
  const files =
    entry.attachments.length === 0
      ? ''
      : `<ul class="hd-pt-files" aria-label="${esc(t('portal.ticket.attachments'))}">${entry.attachments
          .map(
            (file) =>
              `<li><a class="hd-pt-file" href="${esc(view.attachmentPath(view.ticket.reference, file.id))}">${FILE_ICON}<bdi dir="ltr">${esc(file.name)}</bdi></a></li>`,
          )
          .join('')}</ul>`;
  return `<article class="hd-pt-msg" aria-label="${esc(t('portal.ticket.articleLabel', { sender: who.name, time }))}"><div class="hd-pt-who"><strong><bdi>${esc(who.name)}</bdi></strong>${who.tag === null ? '' : `<span class="hd-pt-tag">${esc(who.tag)}</span>`}<time datetime="${esc(entry.at)}">${esc(time)}</time></div><div class="hd-pt-bubble${team ? ' hd-pt-bubble-team' : ''}" dir="auto">${plainTextToHtml(entry.text)}${entry.truncated ? `<p class="hd-pt-quiet">${esc(t('portal.ticket.truncated'))}</p>` : ''}${files}${entry.moreFiles > 0 ? `<p class="hd-pt-quiet">${esc(t('portal.ticket.moreFiles', { count: entry.moreFiles }))}</p>` : ''}</div></article>`;
};

export const ticketMain = (view: TicketView): string => {
  const { t, ticket } = view;
  const date = formatDate(new Date(ticket.createdAt), view.locale, view.timeZone);
  const channel = t(`portal.channel.${ticket.channel}`);
  const opened =
    ticket.openedBy.kind === 'you'
      ? t('portal.ticket.openedByYou', { date, channel })
      : ticket.openedBy.kind === 'person'
        ? t('portal.ticket.openedBy', { name: ticket.openedBy.name, date, channel })
        : t('portal.ticket.openedByUnknown', { date, channel });
  const thread =
    ticket.messages.length === 0
      ? `<p class="hd-pt-quiet">${esc(t('portal.ticket.noMessages'))}</p>`
      : ticket.messages.map((entry) => message(view, entry)).join('');
  return `<main class="hd-portal-page" id="hd-main" tabindex="-1"><div class="hd-pt-ticket"><a class="hd-pt-back" href="${esc(view.listHref)}">${icon('chevronLeft', 14, true)}${esc(t('portal.ticket.back'))}</a><header class="hd-pt-title"><h1 class="hd-display hd-portal-h1 hd-pt-h1" id="hd-h1" tabindex="-1" dir="auto">${esc(ticket.subject)}</h1><div class="hd-pt-meta"><span class="hd-pt-ref" dir="ltr">${esc(ticket.reference)}</span>${pill(t, ticket.status)}<span>${esc(opened)}</span></div></header><section class="hd-pt-thread" aria-label="${esc(t('portal.ticket.thread'))}">${thread}</section></div></main>`;
};

/** The two pages' rules, after the sign-in pages'; every value a token or a DESIGN scale step. */
export const TICKET_CSS = `
.hd-pt-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.hd-pt-head .hd-portal-h1 { font-size: 28px; line-height: 36px; }
.hd-portal-page { display: flex; flex-direction: column; gap: 20px; }
.hd-pt-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.hd-pt-switch { display: inline-flex; gap: 4px; padding: 4px; border-radius: var(--hd-radius-lg); background: var(--hd-bg-muted); }
.hd-pt-seg { min-block-size: 44px; padding-inline: 14px; border-radius: var(--hd-radius-md); display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: var(--hd-text-primary); }
.hd-pt-seg:hover { text-decoration: none; background: var(--hd-bg-surface); }
.hd-pt-seg[aria-current="true"] { background: var(--hd-bg-surface); box-shadow: 0 0 0 1px var(--hd-border-strong); }
.hd-pt-count { font-family: var(--hd-font-mono); font-size: 12px; color: var(--hd-text-secondary); }
.hd-pt-search { margin-inline-start: auto; margin-block: 0; }
.hd-pt-field { inline-size: 280px; max-inline-size: 100%; block-size: 44px; box-sizing: border-box; padding-inline: 12px; display: flex; align-items: center; gap: 8px; border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-secondary); }
.hd-pt-field:focus-within { border-color: var(--hd-border-focus); }
.hd-pt-field input { border: 0; outline: 0; background: transparent; font: inherit; font-size: 16px; flex-grow: 1; min-inline-size: 0; color: var(--hd-text-primary); }
.hd-pt-notice { display: flex; gap: 10px; padding: 12px; border-radius: var(--hd-radius-md); background: var(--hd-bg-muted); color: var(--hd-text-primary); font-size: 14px; line-height: 20px; }
.hd-pt-notice svg { flex-shrink: 0; margin-block-start: 2px; }
.hd-pt-list { margin: 0; padding: 0; list-style: none; border-radius: var(--hd-radius-lg); border: 1px solid var(--hd-border-default); background: var(--hd-bg-surface); overflow: hidden; }
.hd-pt-list li + li { border-block-start: 1px solid var(--hd-border-default); }
.hd-pt-row { display: flex; align-items: center; gap: 16px; min-block-size: 68px; padding: 10px 20px; color: var(--hd-text-primary); }
.hd-pt-row:hover { background: var(--hd-bg-canvas); text-decoration: none; }
.hd-pt-main { flex-grow: 1; min-inline-size: 0; display: flex; flex-direction: column; gap: 2px; }
.hd-pt-subject { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: start; }
.hd-pt-sub { font-size: 14px; line-height: 20px; color: var(--hd-text-secondary); display: flex; gap: 12px; flex-wrap: wrap; }
.hd-pt-ref { font-family: var(--hd-font-mono); }
.hd-pt-only { display: inline-flex; align-items: center; gap: 4px; }
.hd-pt-pill { block-size: 24px; padding-inline: 10px; border-radius: var(--hd-radius-full); font-size: 14px; font-weight: 500; display: inline-flex; align-items: center; white-space: nowrap; }
.hd-pt-pill-open { background: var(--hd-action-primary-tint); color: var(--hd-status-success-text); }
.hd-pt-pill-waiting_you { background: var(--hd-status-warning-tint); color: var(--hd-status-warning-text); }
.hd-pt-pill-waiting_us { background: var(--hd-status-info-tint); color: var(--hd-status-info-text); }
.hd-pt-pill-solved { background: var(--hd-bg-muted); color: var(--hd-text-secondary); }
.hd-pt-more { display: flex; justify-content: center; }
.hd-pt-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px 20px; text-align: center; border-radius: var(--hd-radius-lg); border: 1px solid var(--hd-border-default); background: var(--hd-bg-surface); }
.hd-pt-empty-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.hd-pt-empty-body { margin: 0; font-size: 14px; line-height: 20px; color: var(--hd-text-secondary); }
.hd-pt-ticket { max-inline-size: 760px; display: flex; flex-direction: column; gap: 20px; }
.hd-pt-back { min-block-size: 44px; display: inline-flex; align-items: center; gap: 4px; font-size: 14px; }
.hd-pt-title { display: flex; flex-direction: column; gap: 6px; min-inline-size: 0; }
.hd-pt-h1 { overflow-wrap: anywhere; }
.hd-pt-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 14px; color: var(--hd-text-secondary); }
.hd-pt-thread { display: flex; flex-direction: column; gap: 16px; }
.hd-pt-quiet { margin: 0; font-size: 14px; color: var(--hd-text-secondary); }
.hd-pt-msg { display: flex; flex-direction: column; gap: 6px; }
.hd-pt-who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; color: var(--hd-text-secondary); }
.hd-pt-who strong { color: var(--hd-text-primary); font-weight: 500; }
.hd-pt-tag { font-size: 12px; line-height: 16px; padding-inline: 6px; border-radius: var(--hd-radius-sm); background: var(--hd-bg-muted); color: var(--hd-text-primary); }
.hd-pt-bubble { padding: 12px 14px; border-radius: var(--hd-radius-lg); border: 1px solid var(--hd-border-default); background: var(--hd-bg-surface); display: flex; flex-direction: column; gap: 10px; overflow-wrap: anywhere; }
.hd-pt-bubble p { margin: 0; }
.hd-pt-bubble-team { background: var(--hd-action-primary-tint); border-color: var(--hd-action-primary-tint); }
.hd-pt-files { margin: 0; padding: 0; list-style: none; display: flex; gap: 8px; flex-wrap: wrap; }
.hd-pt-file { min-block-size: 44px; padding-inline: 10px; border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: var(--hd-text-primary); }
@media (max-width: 720px) { .hd-pt-search { margin-inline-start: 0; inline-size: 100%; } .hd-pt-field { inline-size: 100%; } .hd-pt-row { padding-inline: 16px; } }
`;

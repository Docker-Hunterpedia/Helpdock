import type { PowChallenge } from '@helpdock/channels';
import { escapeHtml } from '@helpdock/channels';
import type { HcLocale } from '@helpdock/schemas';
import { icon } from '../help-center/site/render/icons.js';
import type { Translate } from '../help-center/site/render/text.js';
import { POW_FIELD } from '../web-form/page/render.js';

/**
 * The bodies of the portal's sign-in pages (M21-02, artboard
 * `HelpCenter/Portal-SignIn`). The frame, header and footer are the help
 * center's (`renderPortalPage`); this file draws only what is inside `<main>`.
 *
 * Every page has one `h1` that takes focus when the page loads (the board's
 * accessibility note), every field is labelled and described by its error, and
 * every value that reaches markup goes through `escapeHtml`.
 */

const esc = escapeHtml;

/** The words of the built-in check, from the web form's catalog. */
export interface PowWords {
  readonly label: string;
  readonly needsScript: string;
  readonly checking: string;
  readonly verified: string;
  readonly failed: string;
  readonly builtIn: string;
  readonly retry: string;
}

export interface PowStrip {
  readonly challenge: PowChallenge;
  readonly refreshPath: string;
  readonly words: PowWords;
}

export type SignInError = 'invalid' | 'tooMany' | 'captcha';

export interface SignInView {
  readonly t: Translate;
  readonly locale: HcLocale;
  readonly action: string;
  readonly contactHref: string;
  readonly email: string;
  readonly error: SignInError | null;
  readonly csrf: string;
  readonly next: string | null;
  readonly pow: PowStrip | null;
}

const POW_ICONS =
  '<svg class="hd-icon hd-pow-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>' +
  '<svg class="hd-icon hd-pow-ok" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>' +
  '<svg class="hd-icon hd-pow-alert" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';

const powStrip = (pow: PowStrip): string => {
  const words = (['checking', 'verified', 'failed'] as const)
    .map((state) => ` data-${state}="${esc(pow.words[state])}"`)
    .join('');
  return `<div class="hd-captcha hd-pow" id="wf-pow" role="status" aria-live="polite" aria-label="${esc(pow.words.label)}" data-state="noscript" data-challenge="${esc(JSON.stringify(pow.challenge))}" data-refresh="${esc(pow.refreshPath)}"${words}>${POW_ICONS}<span class="hd-pow-text">${esc(pow.words.needsScript)}</span><span class="hd-pow-caption">${esc(pow.words.builtIn)}</span><button class="hd-pow-retry" type="button" hidden>${esc(pow.words.retry)}</button><input type="hidden" name="${POW_FIELD}" value=""></div>`;
};

const hiddenFields = (view: { csrf: string; locale: HcLocale; next: string | null }): string =>
  `<input type="hidden" name="csrf" value="${esc(view.csrf)}"><input type="hidden" name="lang" value="${view.locale}">${view.next === null ? '' : `<input type="hidden" name="next" value="${esc(view.next)}">`}`;

const heading = (text: string): string =>
  `<h1 class="hd-display hd-portal-h1" id="hd-h1" tabindex="-1">${esc(text)}</h1>`;

/** Moves focus to the h1 after each step (the board's accessibility note). The page's nonce'd script. */
export const FOCUS_SCRIPT = "document.getElementById('hd-h1')?.focus();";

const shell = (content: string): string =>
  `<main class="hd-portal" id="hd-main" tabindex="-1"><div class="hd-portal-card">${content}</div></main>`;

export const signInMain = (view: SignInView): string => {
  const { t, error } = view;
  const invalid = error === 'invalid' || error === 'captcha';
  const errorText =
    error === 'captcha' ? t('portal.signIn.captchaFailed') : t('portal.signIn.invalid');
  const warning =
    error === 'tooMany'
      ? `<p class="hd-portal-warning" role="alert">${icon('alert', 16)}<span>${esc(t('portal.signIn.tooMany'))}</span></p>`
      : '';
  const fieldError = invalid
    ? `<p class="hd-error" id="hd-email-error" role="alert">${icon('alert', 14)}<span>${esc(errorText)}</span></p>`
    : '';
  return shell(`${heading(t('portal.signIn.title'))}
<p class="hd-portal-lead">${esc(t('portal.signIn.lead'))}</p>
${warning}
<form method="post" action="${esc(view.action)}" class="hd-portal-form" novalidate>
${hiddenFields(view)}
<div class="hd-field"><label class="hd-label" for="hd-email">${esc(t('portal.signIn.email'))}</label>
<input class="hd-input" id="hd-email" name="email" type="email" inputmode="email" autocomplete="email" dir="ltr" required value="${esc(view.email)}" placeholder="${esc(t('portal.signIn.placeholder'))}"${invalid ? ' aria-invalid="true" aria-describedby="hd-email-error"' : ''}>
${fieldError}</div>
${view.pow === null ? '' : powStrip(view.pow)}
<button class="hd-button hd-button-lg hd-portal-wide" type="submit"${error === 'tooMany' ? ' disabled' : ''}>${esc(t('portal.signIn.submit'))}</button>
</form>
<p class="hd-caption hd-portal-note">${esc(t('portal.signIn.newHere'))} <a href="${esc(view.contactHref)}">${esc(t('portal.signIn.sendMessage'))}</a> ${esc(t('portal.signIn.instead'))}</p>`);
};

const bdi = (value: string): string =>
  `<bdi dir="ltr" class="hd-portal-address">${esc(value)}</bdi>`;

export const sentMain = (view: { t: Translate; email: string; signInHref: string }): string => {
  const { t } = view;
  const another = `<a href="${esc(view.signInHref)}">${esc(t('portal.sent.another'))}</a>`;
  return shell(`<span class="hd-tile" aria-hidden="true">${icon('mail', 20)}</span>
${heading(t('portal.sent.title'))}
<p class="hd-portal-lead">${t('portal.sent.body', { email: bdi(view.email) })}</p>
<p class="hd-caption hd-portal-note">${t('portal.sent.hint', { link: another })}</p>`);
};

export interface ConfirmView {
  readonly t: Translate;
  readonly locale: HcLocale;
  readonly siteName: string;
  readonly email: string;
  readonly token: string;
  readonly action: string;
  readonly csrf: string;
  readonly next: string | null;
}

export const confirmMain = (view: ConfirmView): string => {
  const { t } = view;
  return shell(`${heading(t('portal.confirm.title'))}
<p class="hd-portal-lead">${t('portal.confirm.body', { site: `<bdi>${esc(view.siteName)}</bdi>`, email: bdi(view.email) })}</p>
<form method="post" action="${esc(view.action)}" class="hd-portal-form">
${hiddenFields(view)}<input type="hidden" name="token" value="${esc(view.token)}">
<button class="hd-button hd-button-lg hd-portal-wide" type="submit">${esc(t('portal.confirm.submit'))}</button>
</form>
<p class="hd-caption hd-portal-note">${esc(t('portal.confirm.note'))}</p>`);
};

/** The expired and used pages: a title, a sentence and the two ways forward. */
export const deadLinkMain = (view: {
  t: Translate;
  kind: 'expired' | 'used';
  signInHref: string;
  ticketsHref: string;
}): string => {
  const { t, kind } = view;
  return shell(`${heading(t(`portal.${kind}.title`))}
<p class="hd-portal-lead">${esc(t(`portal.${kind}.body`))}</p>
<div class="hd-portal-actions"><a class="hd-button hd-button-lg" href="${esc(view.signInHref)}">${esc(t('portal.expired.newLink'))}</a><a class="hd-button-secondary hd-button-lg" href="${esc(view.ticketsHref)}">${esc(t('portal.nav.tickets'))}</a></div>`);
};

/** A form whose CSRF token did not match: nothing was done. */
export const staleMain = (view: { t: Translate; signInHref: string }): string => {
  const { t } = view;
  return shell(`${heading(t('portal.stale.title'))}
<p class="hd-portal-lead">${esc(t('portal.stale.body'))}</p>
<div class="hd-portal-actions"><a class="hd-button hd-button-lg" href="${esc(view.signInHref)}">${esc(t('portal.stale.action'))}</a></div>`);
};

/** The signed-in landing M21-03 replaces with the ticket list: the title and nothing else. */
export const ticketsMain = (view: { t: Translate }): string =>
  `<main class="hd-portal-page" id="hd-main" tabindex="-1">${heading(view.t('portal.nav.tickets'))}</main>`;

/** The sign-in pages' rules, after the help center's own; every value a token or a DESIGN scale step. */
export const PORTAL_CSS = `
.hd-portal { flex-grow: 1; inline-size: 100%; max-inline-size: 720px; margin-inline: auto; padding-block: 64px; padding-inline: 16px; display: flex; justify-content: center; align-items: flex-start; }
.hd-portal-card { inline-size: 100%; max-inline-size: 440px; padding: 32px; display: flex; flex-direction: column; align-items: flex-start; gap: 16px; border: 1px solid var(--hd-border-default); border-radius: var(--hd-radius-lg); background: var(--hd-bg-surface); box-shadow: var(--hd-elevation-1); }
.hd-portal-page { flex-grow: 1; inline-size: 100%; max-inline-size: 1280px; margin-inline: auto; padding-block: 40px; padding-inline: 64px; }
.hd-portal-h1 { font-size: 24px; line-height: 32px; }
.hd-portal-h1:focus { outline: none; }
.hd-portal-lead { margin: 0; font-size: 16px; line-height: 24px; color: var(--hd-text-secondary); }
.hd-portal-address { font-weight: 600; color: var(--hd-text-primary); overflow-wrap: anywhere; }
.hd-portal-note { margin: 0; font-size: 14px; line-height: 20px; }
.hd-portal-form { inline-size: 100%; display: flex; flex-direction: column; gap: 16px; margin: 0; }
.hd-portal-wide { inline-size: 100%; }
.hd-portal-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.hd-portal-warning { margin: 0; padding: 12px; inline-size: 100%; display: flex; align-items: center; gap: 8px; border-radius: var(--hd-radius-md); background: var(--hd-status-warning-tint); color: var(--hd-status-warning-text); font-size: 14px; line-height: 20px; }
.hd-tile { inline-size: 40px; block-size: 40px; border-radius: var(--hd-radius-md); background: var(--hd-action-primary-tint); color: var(--hd-action-primary); display: inline-flex; align-items: center; justify-content: center; }
.hd-field { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; border: 0; min-inline-size: 0; }
.hd-label { font-size: 14px; line-height: 20px; font-weight: 500; }
.hd-input { block-size: 44px; inline-size: 100%; padding-inline: 12px; border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-primary); font: inherit; font-size: 16px; }
.hd-input:focus { border-color: var(--hd-border-focus); }
.hd-input[aria-invalid="true"] { border-color: var(--hd-status-danger); }
.hd-error { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--hd-status-danger-text); }
.hd-button-secondary.hd-button-lg { padding-inline: 20px; }
.hd-pow { inline-size: 100%; min-block-size: 64px; padding-inline: 12px; display: flex; align-items: center; gap: 12px; border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong); background: var(--hd-bg-canvas); font-size: 14px; line-height: 20px; }
.hd-pow svg { flex-shrink: 0; display: none; color: var(--hd-text-secondary); }
.hd-pow-text { flex-grow: 1; }
.hd-pow-caption { font-size: 12px; line-height: 16px; color: var(--hd-text-secondary); }
.hd-pow-retry { block-size: 44px; padding-inline: 16px; border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-primary); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.hd-pow-retry[hidden] { display: none; }
.hd-pow[data-state="checking"] .hd-pow-spin { display: inline; animation: hd-spin 1s linear infinite; }
.hd-pow[data-state="verified"] .hd-pow-ok { display: inline; color: var(--hd-status-success-text); }
.hd-pow[data-state="failed"] { border-color: var(--hd-status-danger); }
.hd-pow[data-state="failed"] .hd-pow-alert { display: inline; color: var(--hd-status-danger-text); }
.hd-pow[data-state="failed"] .hd-pow-caption { display: none; }
@keyframes hd-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .hd-pow[data-state="checking"] .hd-pow-spin { animation: none; } }
@media (max-width: 720px) { .hd-portal { padding-block: 32px; } .hd-portal-card { padding: 24px; } .hd-portal-page { padding-inline: 16px; } }
`;

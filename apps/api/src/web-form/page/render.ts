import { type CaptchaRenderConfig, escapeHtml } from '@helpdock/channels';
import { createI18n, dir, type Locale } from '@helpdock/i18n';
import {
  WEB_FORM_REFERENCE_PLACEHOLDER,
  type WebFormFieldError,
  type WebFormFormError,
} from '@helpdock/schemas';
import { ATTACHMENTS_FIELD } from '../submission.js';
import { pageStylesheet } from './styles.js';

/**
 * The hosted form as HTML (M4-09, artboards `WebFormEN` and `WebFormAR`),
 * rendered by the api with no script of its own: the form posts, the server
 * answers with the page again — with its errors, or with the ticket reference.
 * ADR 0013 says why this page is not in the admin bundle.
 *
 * Everything that came from outside — the brand's name, the Admin's labels and
 * thank-you message, what the customer typed — goes through `escapeHtml`.
 * The i18n instance does not escape (`escapeValue: false`), so this file is
 * the only thing standing between a value and the markup.
 */

export interface PageField {
  /** The field reference, which is also the control's `name`. */
  readonly field: string;
  readonly label: string;
  /** `name`, `email`, `subject`, `long_text`, or a custom field type. */
  readonly type: string;
  readonly required: boolean;
  readonly options: readonly string[];
}

export interface PageAttachments {
  readonly max: number;
  /** The MIME types the file picker offers. */
  readonly accept: readonly string[];
  /** Sizes and types, already worded for the page's language. */
  readonly hint: string;
}

export type PageState =
  | {
      readonly kind: 'form';
      readonly fields: readonly PageField[];
      readonly values: ReadonlyMap<string, readonly string[]>;
      readonly fieldErrors: ReadonlyMap<string, WebFormFieldError>;
      readonly formError: WebFormFormError | null;
      readonly submissionId: string;
      readonly attachments: PageAttachments | null;
      readonly captcha: CaptchaRenderConfig | null;
      /** M5-08: the help center article "Still need help?" came from, carried to the post. */
      readonly articleId?: string | null;
    }
  | { readonly kind: 'success'; readonly reference: string; readonly thankYou: string }
  | { readonly kind: 'closed' | 'unavailable' | 'not_found' };

export interface PageView {
  readonly locale: Locale;
  /** Null for the page that names no brand at all. */
  readonly brandName: string | null;
  /** The form's own path, without a query: where it posts and where "Send another" goes. */
  readonly path: string;
  /** `/` on the help center host; null where there is no help center to link to. */
  readonly helpCenterHref: string | null;
  readonly nonce: string;
  readonly state: PageState;
}

/** Served by `FontsController` from `packages/ui/fonts` (DESIGN §3: self-hosted, never a third party). */
export const FONTS_STYLESHEET = '/_hd/fonts/fonts.css';

export const HONEYPOT_FIELD = 'hd_website';
export const SUBMISSION_FIELD = 'hd_submission';
export const LANG_FIELD = 'lang';
/** M5-08: the article id, from `?article=` on the page to the hidden field of the post. */
export const ARTICLE_FIELD = 'hd_article';

/** A DOM id for a field reference: `custom:order_number` → `wf-custom-order_number`. */
export const fieldId = (field: string): string => `wf-${field.replace(/[^a-z0-9_-]/gi, '-')}`;

const OTHER_LOCALE: Readonly<Record<Locale, Locale>> = { en: 'ar', ar: 'en' };

const ALERT_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';
const SMALL_ALERT_ICON = ALERT_ICON.replaceAll('"16"', '"14"');
const CHECK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const translator = (locale: Locale): Translate => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'webform');
  // i18next's key union is checked where the keys are literals; here they are
  // built from codes, so the call goes through a looser signature.
  return (key, options) => (t as unknown as Translate)(key, options);
};

/** The brand's thank-you message with the reference in place of the placeholder. */
export const thankYouText = (template: string, reference: string): string =>
  template.replaceAll(WEB_FORM_REFERENCE_PLACEHOLDER, reference);

const langHref = (path: string, locale: Locale): string => `${path}?${LANG_FIELD}=${locale}`;

const header = (view: PageView, t: Translate): string => {
  const brand = view.brandName ?? '';
  const initial = escapeHtml(Array.from(brand.trim())[0]?.toUpperCase() ?? 'H');
  const other = OTHER_LOCALE[view.locale];
  const home = view.helpCenterHref ?? langHref(view.path, view.locale);
  const helpCenter =
    view.helpCenterHref === null
      ? ''
      : `<a href="${escapeHtml(view.helpCenterHref)}">${escapeHtml(t('nav.helpCenter'))}</a>`;

  return `<header class="hd-header">
<a class="hd-brand" href="${escapeHtml(home)}"><span class="hd-mark" aria-hidden="true">${initial}</span>${escapeHtml(brand)}</a>
<nav class="hd-nav" aria-label="${escapeHtml(t('nav.label'))}">${helpCenter}<a href="${escapeHtml(langHref(view.path, view.locale))}" aria-current="page">${escapeHtml(t('nav.contact'))}</a></nav>
<a class="hd-lang" href="${escapeHtml(langHref(view.path, other))}" lang="${other}" hreflang="${other}">${escapeHtml(t('otherLanguage'))}</a>
</header>`;
};

const labelFor = (field: PageField, t: Translate): string =>
  `${escapeHtml(field.label)} <span>${escapeHtml(field.required ? t('required') : t('optional'))}</span>`;

const errorLine = (id: string, error: WebFormFieldError, t: Translate): string =>
  `<p class="hd-error" id="${id}">${SMALL_ALERT_ICON}${escapeHtml(t(`errors.${error}`))}</p>`;

const describedBy = (ids: readonly string[]): string =>
  ids.length === 0 ? '' : ` aria-describedby="${ids.join(' ')}"`;

const WIDE_TYPES = new Set(['long_text', 'multi_select', 'checkbox']);

const control = (
  field: PageField,
  value: readonly string[],
  error: WebFormFieldError | undefined,
  t: Translate,
): string => {
  const id = fieldId(field.field);
  const errorId = `${id}-e`;
  const invalid = error === undefined ? '' : ' aria-invalid="true"';
  const required = field.required ? ' required' : '';
  const described = describedBy(error === undefined ? [] : [errorId]);
  const name = escapeHtml(field.field);
  const current = value[0] ?? '';
  const errorHtml = error === undefined ? '' : errorLine(errorId, error, t);
  const wide = WIDE_TYPES.has(field.type) ? ' hd-wide' : '';

  switch (field.type) {
    case 'long_text':
      return `<div class="hd-field${wide}"><label class="hd-label" for="${id}">${labelFor(field, t)}</label><textarea class="hd-input" id="${id}" name="${name}" rows="5"${required}${invalid}${described}>${escapeHtml(current)}</textarea>${errorHtml}</div>`;
    case 'select': {
      const options = field.options
        .map(
          (option) =>
            `<option value="${escapeHtml(option)}"${option === current ? ' selected' : ''}>${escapeHtml(option)}</option>`,
        )
        .join('');
      return `<div class="hd-field${wide}"><label class="hd-label" for="${id}">${labelFor(field, t)}</label><select class="hd-input" id="${id}" name="${name}"${required}${invalid}${described}><option value="">${escapeHtml(t('choose'))}</option>${options}</select>${errorHtml}</div>`;
    }
    case 'multi_select': {
      const boxes = field.options
        .map(
          (option, index) =>
            `<label class="hd-check"><input type="checkbox" id="${id}-${String(index)}" name="${name}" value="${escapeHtml(option)}"${value.includes(option) ? ' checked' : ''}>${escapeHtml(option)}</label>`,
        )
        .join('');
      return `<fieldset class="hd-field${wide}" id="${id}"${invalid}${described}><legend class="hd-label">${labelFor(field, t)}</legend>${boxes}${errorHtml}</fieldset>`;
    }
    case 'checkbox':
      return `<div class="hd-field${wide}"><label class="hd-check"><input type="checkbox" id="${id}" name="${name}" value="on"${value.length > 0 ? ' checked' : ''}${required}${invalid}${described}>${labelFor(field, t)}</label>${errorHtml}</div>`;
    default: {
      const kind =
        field.type === 'email'
          ? ' type="email" autocomplete="email" dir="ltr" spellcheck="false"'
          : field.type === 'number'
            ? ' type="text" inputmode="decimal" dir="ltr"'
            : field.type === 'date'
              ? ' type="date"'
              : field.type === 'name'
                ? ' type="text" autocomplete="name"'
                : ' type="text"';
      return `<div class="hd-field${wide}"><label class="hd-label" for="${id}">${labelFor(field, t)}</label><input class="hd-input" id="${id}" name="${name}"${kind} value="${escapeHtml(current)}"${required}${invalid}${described}>${errorHtml}</div>`;
    }
  }
};

const attachmentsControl = (
  attachments: PageAttachments,
  error: WebFormFieldError | undefined,
  t: Translate,
): string => {
  const id = fieldId(ATTACHMENTS_FIELD);
  const hintId = `${id}-h`;
  const errorId = `${id}-e`;
  const invalid = error === undefined ? '' : ' aria-invalid="true"';
  const described = describedBy(error === undefined ? [hintId] : [hintId, errorId]);
  const multiple = attachments.max > 1 ? ' multiple' : '';

  return `<div class="hd-field hd-wide"><label class="hd-label" for="${id}">${escapeHtml(t('fields.attachments'))} <span>${escapeHtml(t('optional'))}</span></label><input class="hd-file" id="${id}" name="${ATTACHMENTS_FIELD}" type="file"${multiple} accept="${escapeHtml(attachments.accept.join(','))}"${invalid}${described}><p class="hd-hint" id="${hintId}">${escapeHtml(attachments.hint)}</p>${error === undefined ? '' : errorLine(errorId, error, t)}</div>`;
};

const summary = (
  errors: ReadonlyMap<string, WebFormFieldError>,
  labels: ReadonlyMap<string, string>,
  t: Translate,
): string => {
  const links = [...errors.keys()]
    .map((field) => `<a href="#${fieldId(field)}">${escapeHtml(labels.get(field) ?? field)}</a>`)
    .join('');
  return `<div class="hd-banner hd-banner-danger" role="alert" tabindex="-1" autofocus aria-labelledby="wf-summary">${ALERT_ICON}<div class="hd-banner-body"><span class="hd-banner-title" id="wf-summary">${escapeHtml(t('summary', { count: errors.size }))}</span><span class="hd-banner-links">${links}</span></div></div>`;
};

const formBanner = (error: WebFormFormError, t: Translate): string =>
  `<div class="hd-banner hd-banner-danger" role="alert" tabindex="-1" autofocus>${ALERT_ICON}<span>${escapeHtml(t(`formErrors.${error}`))}</span></div>`;

const formBody = (
  view: PageView,
  state: Extract<PageState, { kind: 'form' }>,
  t: Translate,
): string => {
  const labels = new Map<string, string>(state.fields.map((field) => [field.field, field.label]));
  labels.set(ATTACHMENTS_FIELD, t('fields.attachments'));

  const banner =
    state.fieldErrors.size > 0
      ? summary(state.fieldErrors, labels, t)
      : state.formError === null
        ? ''
        : formBanner(state.formError, t);
  const controls = state.fields
    .map((field) =>
      control(field, state.values.get(field.field) ?? [], state.fieldErrors.get(field.field), t),
    )
    .join('\n');
  const attachments =
    state.attachments === null
      ? ''
      : attachmentsControl(state.attachments, state.fieldErrors.get(ATTACHMENTS_FIELD), t);
  const captcha =
    state.captcha === null
      ? '<span></span>'
      : `<div class="hd-captcha" role="group" aria-label="${escapeHtml(t('captcha.label'))}"><div class="${escapeHtml(state.captcha.widgetClass)}" data-sitekey="${escapeHtml(state.captcha.siteKey)}" data-language="${view.locale}"></div></div>`;

  return `<form class="hd-card" method="post" action="${escapeHtml(view.path)}" enctype="multipart/form-data" novalidate aria-labelledby="wf-heading">
<div class="hd-intro"><h1 id="wf-heading">${escapeHtml(t('heading'))}</h1><p class="hd-lead">${escapeHtml(t('intro'))}</p></div>
${banner}
<input type="hidden" name="${LANG_FIELD}" value="${view.locale}">
<input type="hidden" name="${SUBMISSION_FIELD}" value="${escapeHtml(state.submissionId)}">
${state.articleId ? `<input type="hidden" name="${ARTICLE_FIELD}" value="${escapeHtml(state.articleId)}">\n` : ''}<div class="hd-hp"><label for="wf-hp">Website</label><input id="wf-hp" name="${HONEYPOT_FIELD}" type="text" tabindex="-1" autocomplete="off"></div>
<div class="hd-grid">
${controls}
${attachments}
</div>
<div class="hd-actions">${captcha}<button class="hd-button" type="submit">${escapeHtml(t('submit'))}</button></div>
</form>`;
};

const successBody = (
  view: PageView,
  state: Extract<PageState, { kind: 'success' }>,
  t: Translate,
): string => {
  const MARK = '\u0000ref\u0000';
  const heading = escapeHtml(t('success.heading', { reference: MARK })).replace(
    MARK,
    `<bdi class="mono">${escapeHtml(state.reference)}</bdi>`,
  );
  const helpCenter =
    view.helpCenterHref === null
      ? ''
      : `<a href="${escapeHtml(view.helpCenterHref)}">${escapeHtml(t('success.helpCenter'))}</a>`;

  return `<section class="hd-card" aria-labelledby="wf-ok">
<div class="hd-banner hd-banner-success" role="status">${CHECK_ICON}<span>${escapeHtml(t('success.status'))}</span></div>
<h1 id="wf-ok">${heading}</h1>
<p class="hd-secondary">${escapeHtml(thankYouText(state.thankYou, state.reference))}</p>
<div class="hd-links">${helpCenter}<a href="${escapeHtml(langHref(view.path, view.locale))}">${escapeHtml(t('success.another'))}</a></div>
</section>`;
};

const noticeBody = (heading: string, body: string): string =>
  `<section class="hd-card" aria-labelledby="wf-notice"><h1 id="wf-notice">${escapeHtml(heading)}</h1><p class="hd-secondary">${escapeHtml(body)}</p></section>`;

const bodyFor = (view: PageView, t: Translate): string => {
  const brand = view.brandName ?? '';
  switch (view.state.kind) {
    case 'form':
      return formBody(view, view.state, t);
    case 'success':
      return successBody(view, view.state, t);
    case 'closed':
      return noticeBody(t('closed.heading'), t('closed.body', { brand }));
    case 'unavailable':
      return noticeBody(t('unavailable.heading'), t('unavailable.body', { brand }));
    case 'not_found':
      return noticeBody(t('notFound.heading'), t('notFound.body'));
  }
};

const captchaScript = (view: PageView): string =>
  view.state.kind === 'form' && view.state.captcha !== null
    ? `<script src="${escapeHtml(view.state.captcha.scriptUrl)}" async defer nonce="${view.nonce}"></script>`
    : '';

export const renderWebFormPage = (view: PageView): string => {
  const t = translator(view.locale);
  const title =
    view.state.kind === 'not_found'
      ? t('notFound.title')
      : t('title', { brand: view.brandName ?? '' });
  const main = bodyFor(view, t);

  return `<!doctype html>
<html lang="${view.locale}" dir="${dir(view.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${FONTS_STYLESHEET}">
<style nonce="${view.nonce}">${pageStylesheet()}</style>
${captchaScript(view)}
</head>
<body>
${view.brandName === null ? '' : header(view, t)}
<main class="hd-main">
${main}
</main>
</body>
</html>`;
};

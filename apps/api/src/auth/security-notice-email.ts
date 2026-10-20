import type { EmailMessage } from '@helpdock/channels';
import { createI18n, dir, type Locale } from '@helpdock/i18n';
import { fontFallbacks } from '@helpdock/ui/resolve';
import { escapeHtml } from './email-templates.js';

/**
 * The `securityChange` email of the `Email/SecurityChange-M18` artboard: the
 * notice that a credential changed (ASVS 2.2.3, 2.5.5). It has the shape of the
 * staff notification email (`notifications/staff-email.ts`): mark, a caption
 * naming the area, a heading saying what changed, one sentence, a "When" row,
 * an "If this wasn't you" line in the danger colour, one action, and a footer
 * saying why it was sent and that it cannot be turned off.
 *
 * Every sentence is in the `email` catalogs under `securityChange`. A change
 * with its own block there (`oauthConnected`, `oauthDisconnected`) words every
 * line itself; the others share the generic subject, caption, heading, warning
 * and action, and differ by their `body_<change>` sentence.
 */

/** Which credential a notice is about; each has its own sentence. */
export const SECURITY_CHANGES = [
  'password',
  'passwordReset',
  'twoFactorEnabled',
  'twoFactorDisabled',
  'recoveryCodes',
  'oauthConnected',
  'oauthDisconnected',
] as const;
export type SecurityChange = (typeof SECURITY_CHANGES)[number];

/** The changes whose every line is their own, from the M18 artboard. */
const WORDED_CHANGES = new Set<SecurityChange>(['oauthConnected', 'oauthDisconnected']);

const isSecurityChange = (value: string | undefined): value is SecurityChange =>
  (SECURITY_CHANGES as readonly (string | undefined)[]).includes(value);

/** The artboard's colours, as the literal values mail clients need. */
const COLOR = {
  surface: '#FFFFFF',
  border: '#E3DFD6',
  divider: '#EFECE5',
  text: '#16181C',
  body: '#403C35',
  muted: '#5C564C',
  primary: '#0F766E',
  danger: '#8A1B15',
} as const;

/** Month names in the reader's language, digits Latin in both (DESIGN §7). */
const DATE_LOCALE: Record<Locale, string> = { en: 'en-GB', ar: 'ar-u-nu-latn' };

/** `21 Oct 2026, 09:14 (Asia/Riyadh)`. */
const formatWhen = (iso: string, locale: Locale, timeZone: string): string =>
  `${new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(iso))} (${timeZone})`;

const regExpSource = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wraps each address in an isolated left-to-right run, so an Arabic sentence
 * keeps it whole. One pass over the escaped text, longest address first: a
 * second pass could match inside the markup the first one inserted, and the
 * provider account's address is the provider's to choose.
 */
const isolateAddresses = (escaped: string, addresses: readonly string[]): string => {
  const pattern = [...new Set(addresses.map(escapeHtml))]
    .sort((a, b) => b.length - a.length)
    .map(regExpSource)
    .join('|');
  return escaped.replace(new RegExp(pattern, 'g'), (match) => `<bdi dir="ltr">${match}</bdi>`);
};

export interface SecurityNoticeInput {
  readonly to: string;
  readonly name?: string;
  /** The security page. Its host is named in the footer. */
  readonly url: string;
  readonly locale: Locale;
  /** `change` picks the wording; `provider`, `account` and `occurredAt` fill it. */
  readonly values: Readonly<Record<string, string>>;
  /** The zone "When" is told in: the brand the notice is routed through. */
  readonly timeZone?: string;
}

export const renderSecurityNoticeEmail = ({
  to,
  name,
  url,
  locale,
  values,
  timeZone = 'UTC',
}: SecurityNoticeInput): EmailMessage => {
  const { change } = values;
  if (!isSecurityChange(change)) {
    throw new TypeError(`A securityChange email needs a known change, not ${change}`);
  }

  const t = createI18n({ lng: locale }).getFixedT(locale, 'email', 'securityChange');
  const common = { appName: 'Helpdock', email: to, host: new URL(url).host, ...values };
  const own = WORDED_CHANGES.has(change);
  const line = (key: 'subject' | 'eyebrow' | 'heading' | 'warning' | 'action'): string =>
    own ? t(`${change}.${key}` as never, common) : t(key, common);

  const copy = {
    subject: line('subject'),
    eyebrow: line('eyebrow'),
    heading: line('heading'),
    body: own ? t(`${change}.body` as never, common) : t(`body_${change}` as never, common),
    warning: line('warning'),
    action: line('action'),
    footer: t('footer', common),
    brand: 'Helpdock',
  };
  const when =
    values.occurredAt === undefined
      ? null
      : { label: t('when'), value: formatWhen(values.occurredAt, locale, timeZone) };
  const addresses = [to, ...(values.account === undefined ? [] : [values.account])];

  const text = [
    copy.eyebrow,
    copy.heading,
    '',
    copy.body,
    ...(when === null ? [] : ['', `${when.label}: ${when.value}`]),
    '',
    copy.warning,
    '',
    `${copy.action}: ${url}`,
    '',
    copy.footer,
  ].join('\n');
  const html = renderHtml({ locale, url, copy, when, addresses, host: common.host });

  return {
    to: { address: to, ...(name === undefined ? {} : { name }) },
    subject: copy.subject,
    text,
    html,
    locale,
  };
};

interface NoticeCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly body: string;
  readonly warning: string;
  readonly action: string;
  readonly footer: string;
  readonly brand: string;
}

const renderHtml = ({
  locale,
  url,
  copy,
  when,
  addresses,
  host,
}: {
  readonly locale: Locale;
  readonly url: string;
  readonly copy: NoticeCopy;
  readonly when: { readonly label: string; readonly value: string } | null;
  readonly addresses: readonly string[];
  readonly host: string;
}): string => {
  const whenHtml =
    when === null
      ? ''
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border:1px solid ${COLOR.border};border-radius:6px;margin-bottom:20px;text-align:start"><tbody><tr><td style="padding:8px 12px;width:120px;font-size:13px;color:${COLOR.muted}">${escapeHtml(when.label)}</td><td style="padding:8px 12px;font-size:13px;color:${COLOR.text}"><bdi>${escapeHtml(when.value)}</bdi></td></tr></tbody></table>`;

  return [
    `<!doctype html><html lang="${locale}" dir="${dir(locale)}"><body style="margin:0;padding:24px;background:#F7F5F0">`,
    `<table role="presentation" dir="${dir(locale)}" lang="${locale}" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;margin:0 auto;border-collapse:separate;background:${COLOR.surface};border:1px solid ${COLOR.border};border-radius:10px;font-family:${escapeHtml(fontFallbacks.sans)};color:${COLOR.text}">`,
    '<tbody><tr><td style="padding:28px 32px 32px 32px;text-align:start">',
    `<div style="margin-bottom:24px"><span style="display:inline-block;width:28px;height:28px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-weight:600;font-size:14px;line-height:28px;text-align:center">H</span> <span style="font-weight:600;font-size:14px">${escapeHtml(copy.brand)}</span></div>`,
    `<div style="font-size:12px;line-height:16px;font-weight:500;color:${COLOR.muted};margin-bottom:6px">${escapeHtml(copy.eyebrow)}</div>`,
    `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:600">${escapeHtml(copy.heading)}</h1>`,
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.body}">${isolateAddresses(escapeHtml(copy.body), addresses)}</p>`,
    whenHtml,
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.danger}">${escapeHtml(copy.warning)}</p>`,
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-size:15px;line-height:20px;font-weight:500;text-decoration:none">${escapeHtml(copy.action)}</a>`,
    `<p style="margin:28px 0 0 0;padding-top:16px;border-top:1px solid ${COLOR.divider};font-size:12px;line-height:18px;color:${COLOR.muted}">${isolateAddresses(escapeHtml(copy.footer), [host])}</p>`,
    '</td></tr></tbody></table></body></html>',
  ].join('');
};

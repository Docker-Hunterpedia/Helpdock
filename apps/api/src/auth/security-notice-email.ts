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
  'passkeyAdded',
  'passkeyRemoved',
] as const;
export type SecurityChange = (typeof SECURITY_CHANGES)[number];

/**
 * What picks the sentences: a change, or a variant of one. A reset that left
 * passkeys behind says so, with the advice to check them, in words of its own.
 */
type NoticeKind = SecurityChange | 'passwordResetPasskeys';

/** The changes whose every line is their own, from the M18 artboard. */
const WORDED_CHANGES = new Set<NoticeKind>([
  'oauthConnected',
  'oauthDisconnected',
  'passkeyAdded',
  'passkeyRemoved',
  'passwordResetPasskeys',
]);

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
const isolateAddresses = (
  escaped: string,
  addresses: readonly string[],
  names: readonly string[] = [],
): string => {
  const wanted = [...new Set(addresses.map(escapeHtml))];
  const named = [...new Set(names.map(escapeHtml))].filter((name) => !wanted.includes(name));
  const pattern = [...wanted, ...named]
    .sort((a, b) => b.length - a.length)
    .map(regExpSource)
    .join('|');
  return escaped.replace(new RegExp(pattern, 'g'), (match) =>
    wanted.includes(match) ? `<bdi dir="ltr">${match}</bdi>` : `<bdi>${match}</bdi>`,
  );
};

const positiveCount = (value: string | undefined): number => {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 0;
};

/**
 * Which sentence says what still protects the account after a removal: the
 * passkeys left, an authenticator app, both, or (for an account that is not
 * required to have a second factor) neither.
 */
const remainingKey = (remaining: number, totp: boolean): string | null => {
  if (remaining > 0 && totp) return 'remainingBoth';
  if (remaining > 0) return 'remainingPasskeys';
  return totp ? 'remainingTotp' : null;
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

  const i18n = createI18n({ lng: locale });
  const t = i18n.getFixedT(locale, 'email', 'securityChange');
  const has = (key: string): boolean =>
    i18n.exists(`securityChange.${key}`, { lng: locale, ns: 'email' });
  const kept = positiveCount(values.passkeys);
  const kind: NoticeKind =
    change === 'passwordReset' && kept > 0 ? 'passwordResetPasskeys' : change;
  const remaining = positiveCount(values.remaining);
  const common = {
    appName: 'Helpdock',
    email: to,
    host: new URL(url).host,
    ...values,
    count: kind === 'passwordResetPasskeys' ? kept : remaining,
  };
  const own = WORDED_CHANGES.has(kind);
  const line = (key: 'subject' | 'eyebrow' | 'heading' | 'warning' | 'action'): string => {
    if (!own) {
      return t(key, common);
    }
    // A worded change may leave a line out; the reset that kept passkeys has no "if this wasn't you".
    return has(`${kind}.${key}`) ? t(`${kind}.${key}` as never, common) : '';
  };
  const remainder = kind === 'passkeyRemoved' ? remainingKey(remaining, values.totp === '1') : null;
  const body = own ? t(`${kind}.body` as never, common) : t(`body_${kind}` as never, common);

  const copy = {
    subject: line('subject'),
    eyebrow: line('eyebrow'),
    heading: line('heading'),
    body: remainder === null ? body : `${body} ${t(`${kind}.${remainder}` as never, common)}`,
    warning: line('warning'),
    action: line('action'),
    footer: t('footer', common),
    brand: 'Helpdock',
  };
  const device =
    values.browser !== undefined && values.os !== undefined
      ? t('fromDevice', { browser: values.browser, os: values.os })
      : (values.browser ?? values.os);
  const fromParts = [device, values.ip].filter((part): part is string => part !== undefined);
  const from = fromParts.length === 0 ? null : fromParts.join(' · ');
  const rows = [
    ...(values.occurredAt === undefined
      ? []
      : [{ label: t('when'), value: formatWhen(values.occurredAt, locale, timeZone) }]),
    ...(from === null ? [] : [{ label: t('from'), value: from }]),
  ];
  const addresses = [to, ...(values.account === undefined ? [] : [values.account])];

  const text = [
    copy.eyebrow,
    copy.heading,
    '',
    copy.body,
    ...(rows.length === 0 ? [] : ['', ...rows.map((row) => `${row.label}: ${row.value}`)]),
    ...(copy.warning === '' ? [] : ['', copy.warning]),
    '',
    `${copy.action}: ${url}`,
    '',
    copy.footer,
  ].join('\n');
  const html = renderHtml({
    locale,
    url,
    copy,
    rows,
    addresses,
    names: values.passkey === undefined ? [] : [values.passkey],
    host: common.host,
  });

  return {
    to: { address: to, ...(name === undefined ? {} : { name }) },
    subject: copy.subject,
    text,
    html,
    locale,
  };
};

interface NoticeRow {
  readonly label: string;
  readonly value: string;
}

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
  rows,
  addresses,
  names,
  host,
}: {
  readonly locale: Locale;
  readonly url: string;
  readonly copy: NoticeCopy;
  readonly rows: readonly NoticeRow[];
  readonly addresses: readonly string[];
  /** Names the person chose; isolated so a right-to-left name does not scramble the sentence. */
  readonly names: readonly string[];
  readonly host: string;
}): string => {
  const rowHtml = rows.map(
    (row, index) =>
      `<tr><td style="padding:8px 12px;width:120px;font-size:13px;color:${COLOR.muted};${index === 0 ? '' : `border-top:1px solid ${COLOR.divider};`}">${escapeHtml(row.label)}</td><td style="padding:8px 12px;font-size:13px;color:${COLOR.text};${index === 0 ? '' : `border-top:1px solid ${COLOR.divider};`}"><bdi>${escapeHtml(row.value)}</bdi></td></tr>`,
  );
  const whenHtml =
    rows.length === 0
      ? ''
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border:1px solid ${COLOR.border};border-radius:6px;margin-bottom:20px;text-align:start"><tbody>${rowHtml.join('')}</tbody></table>`;

  return [
    `<!doctype html><html lang="${locale}" dir="${dir(locale)}"><body style="margin:0;padding:24px;background:#F7F5F0">`,
    `<table role="presentation" dir="${dir(locale)}" lang="${locale}" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;margin:0 auto;border-collapse:separate;background:${COLOR.surface};border:1px solid ${COLOR.border};border-radius:10px;font-family:${escapeHtml(fontFallbacks.sans)};color:${COLOR.text}">`,
    '<tbody><tr><td style="padding:28px 32px 32px 32px;text-align:start">',
    `<div style="margin-bottom:24px"><span style="display:inline-block;width:28px;height:28px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-weight:600;font-size:14px;line-height:28px;text-align:center">H</span> <span style="font-weight:600;font-size:14px">${escapeHtml(copy.brand)}</span></div>`,
    `<div style="font-size:12px;line-height:16px;font-weight:500;color:${COLOR.muted};margin-bottom:6px">${escapeHtml(copy.eyebrow)}</div>`,
    `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:600">${escapeHtml(copy.heading)}</h1>`,
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.body}">${isolateAddresses(escapeHtml(copy.body), addresses, names)}</p>`,
    whenHtml,
    copy.warning === ''
      ? ''
      : `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.danger}">${escapeHtml(copy.warning)}</p>`,
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-size:15px;line-height:20px;font-weight:500;text-decoration:none">${escapeHtml(copy.action)}</a>`,
    `<p style="margin:28px 0 0 0;padding-top:16px;border-top:1px solid ${COLOR.divider};font-size:12px;line-height:18px;color:${COLOR.muted}">${isolateAddresses(escapeHtml(copy.footer), [host])}</p>`,
    '</td></tr></tbody></table></body></html>',
  ].join('');
};

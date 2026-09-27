import type { EmailMessage } from '@helpdock/channels';
import { createI18n, dir, type Locale } from '@helpdock/i18n';
import {
  excerptOf,
  type NotificationDetail,
  type NotificationKind,
  type TicketPriority,
} from '@helpdock/schemas';
import { escapeHtml } from '../auth/email-templates.js';

/**
 * The staff notification email of the `EmailStaffNotification` artboard, in
 * the recipient's app language. Every sentence is in the `email` catalogs
 * under `staffNotification`; this file only decides the shape around them.
 *
 * One 600 px table with inline styles and no remote images, like every email
 * Helpdock sends (`auth/email-templates.ts` says why). `dir` and `lang` are set
 * on the table, because an Arabic message laid out left to right is broken.
 * Contact names, subjects and note text stay in the language they were written
 * in, and are isolated with `<bdi>` where they sit inside a sentence of the
 * other direction.
 */

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
  urgent: '#B3261E',
  noteBg: '#FBEEDF',
  noteBorder: '#B45309',
  kicker: '#0A4A45',
} as const;

const SANS: Record<Locale, string> = {
  en: "'IBM Plex Sans', system-ui, sans-serif",
  ar: "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif",
};
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

export interface StaffEmailInput {
  readonly kind: NotificationKind;
  readonly locale: Locale;
  readonly to: { readonly address: string; readonly name: string };
  readonly recipientId: string;
  readonly ticket: {
    readonly id: string;
    readonly reference: string;
    readonly subject: string;
    readonly departmentName: string;
    readonly priority: TicketPriority;
    readonly contactName: string | null;
    readonly assigneeId: string | null;
    readonly assigneeName: string | null;
  };
  readonly actorName: string | null;
  /** The note or reply the notification is about, as plain text. */
  readonly messageText: string | null;
  readonly detail: NotificationDetail;
  /** `APP_URL`: links point into the admin app of this install. */
  readonly appUrl: string;
}

const isSla = (kind: NotificationKind): boolean =>
  kind === 'sla_warning' || kind === 'sla_breached' || kind === 'escalated';

const link = (appUrl: string, path: string): string => new URL(path, appUrl).toString();

export const renderStaffNotificationEmail = (input: StaffEmailInput): EmailMessage => {
  const { kind, locale, ticket, detail } = input;
  const t = createI18n({ lng: locale }).getFixedT(locale, 'email', 'staffNotification');

  const values = {
    reference: ticket.reference,
    subject: ticket.subject,
    contact: ticket.contactName ?? t('aContact'),
    actor: input.actorName ?? t('someone'),
    clock: t(`clock.${detail.clock ?? 'unknown'}`),
    percent: String(detail.stepPercent ?? 0),
    email: input.to.address,
  };

  const subject = t(`subject.${kind}`, values);
  const kicker = t(`kicker.${kind}`, values);
  const heading = t(`heading.${kind}`, values);
  const body =
    kind === 'assigned'
      ? t(`body.assigned.${detail.assignedBy ?? 'person'}`, values)
      : t(`body.${kind}`, values);

  const quote =
    kind === 'escalated' && detail.message !== undefined
      ? { label: t('ruleLabel'), text: detail.message }
      : input.messageText === null || (kind !== 'mentioned' && kind !== 'replied')
        ? null
        : {
            label: kind === 'mentioned' ? t('noteLabel', values) : t('replyLabel', values),
            text: excerptOf(input.messageText, 400),
          };

  const assignee =
    ticket.assigneeId === null
      ? t('rows.nobody')
      : ticket.assigneeId === input.recipientId
        ? t('rows.you')
        : (ticket.assigneeName ?? t('rows.nobody'));

  const rows: readonly (readonly [string, string, 'reference' | 'priority' | 'plain'])[] = isSla(
    kind,
  )
    ? [
        [t('rows.ticket'), `${ticket.reference} · ${ticket.subject}`, 'reference'],
        [t('rows.contact'), values.contact, 'plain'],
        [t('rows.department'), ticket.departmentName, 'plain'],
        [
          t('rows.priority'),
          t(`priority.${ticket.priority}`),
          ticket.priority === 'urgent' ? 'priority' : 'plain',
        ],
        [t('rows.assignee'), assignee, 'plain'],
      ]
    : [
        [t('rows.ticket'), `${ticket.reference} · ${ticket.subject}`, 'reference'],
        [t('rows.department'), ticket.departmentName, 'plain'],
      ];

  const ticketUrl = link(input.appUrl, `/tickets/${encodeURIComponent(ticket.id)}`);
  const settingsUrl = link(input.appUrl, '/me/notifications');
  const action =
    kind === 'mentioned' ? t('action.reply') : t('action.open', { reference: ticket.reference });
  const why = t(`why.${kind}`);
  const settings = t('settings');
  const sentTo = t('sentTo', values);

  const text = [
    kicker,
    heading,
    '',
    body,
    ...(quote === null ? [] : ['', `${quote.label}:`, quote.text]),
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `${action}: ${ticketUrl}`,
    '',
    `${why} ${settings}: ${settingsUrl}`,
    sentTo,
  ].join('\n');

  const html = renderHtml({
    locale,
    kind,
    kicker,
    heading,
    body,
    quote,
    rows,
    reference: ticket.reference,
    action,
    ticketUrl,
    why,
    settings,
    settingsUrl,
    sentTo,
    brand: t('brand'),
  });

  return {
    to: { address: input.to.address, name: input.to.name },
    subject,
    text,
    html,
    locale,
  };
};

interface HtmlParts {
  readonly locale: Locale;
  readonly kind: NotificationKind;
  readonly brand: string;
  readonly kicker: string;
  readonly heading: string;
  readonly body: string;
  readonly quote: { readonly label: string; readonly text: string } | null;
  readonly rows: readonly (readonly [string, string, 'reference' | 'priority' | 'plain'])[];
  readonly reference: string;
  readonly action: string;
  readonly ticketUrl: string;
  readonly why: string;
  readonly settings: string;
  readonly settingsUrl: string;
  readonly sentTo: string;
}

/** Wraps every occurrence of the ticket reference in a monospaced, isolated `<bdi>`. */
const withReference = (escaped: string, reference: string): string => {
  const ref = escapeHtml(reference);
  return escaped.replaceAll(ref, `<bdi style="font-family:${MONO}">${ref}</bdi>`);
};

const renderHtml = (parts: HtmlParts): string => {
  const { locale, rows } = parts;
  const sans = SANS[locale];
  const kickerColor =
    parts.kind === 'sla_breached' || parts.kind === 'sla_warning' ? COLOR.danger : COLOR.kicker;

  const rowHtml = rows
    .map(([label, value, style], index) => {
      const last = index === rows.length - 1;
      const border = last ? '' : `border-bottom:1px solid ${COLOR.divider};`;
      const cell =
        style === 'priority'
          ? `<span style="display:inline-block;padding:0 8px;border-radius:6px;background:${COLOR.urgent};color:#FFFFFF;font-size:12px;line-height:22px;font-weight:500">${escapeHtml(value)}</span>`
          : style === 'reference'
            ? withReference(escapeHtml(value), parts.reference)
            : `<bdi>${escapeHtml(value)}</bdi>`;
      return `<tr><td style="padding:8px 12px;width:120px;font-size:13px;color:${COLOR.muted};vertical-align:top;${border}">${escapeHtml(label)}</td><td style="padding:8px 12px;font-size:13px;color:${COLOR.text};${border}">${cell}</td></tr>`;
    })
    .join('');

  const quoteHtml =
    parts.quote === null
      ? ''
      : `<div style="margin:0 0 20px 0;padding:12px 14px;border-radius:10px;background:${COLOR.noteBg};border:1px dashed ${COLOR.noteBorder};font-size:14px;line-height:22px;color:${COLOR.body}"><div style="font-size:12px;line-height:16px;font-weight:600;color:${COLOR.noteBorder};margin-bottom:4px">${escapeHtml(parts.quote.label)}</div><div dir="auto" style="text-align:start">${escapeHtml(parts.quote.text)}</div></div>`;

  return [
    `<!doctype html><html lang="${locale}" dir="${dir(locale)}"><body style="margin:0;padding:24px;background:#F7F5F0">`,
    `<table role="presentation" dir="${dir(locale)}" lang="${locale}" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;margin:0 auto;border-collapse:separate;background:${COLOR.surface};border:1px solid ${COLOR.border};border-radius:10px;font-family:${sans};color:${COLOR.text}">`,
    '<tbody><tr><td style="padding:28px 32px 32px 32px;text-align:start">',
    `<div style="margin-bottom:24px"><span style="display:inline-block;width:28px;height:28px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-weight:600;font-size:14px;line-height:28px;text-align:center">H</span> <span style="font-weight:600;font-size:14px">${escapeHtml(parts.brand)}</span></div>`,
    `<div style="font-size:12px;line-height:16px;font-weight:500;color:${kickerColor};margin-bottom:6px">${escapeHtml(parts.kicker)}</div>`,
    `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:600">${withReference(escapeHtml(parts.heading), parts.reference)}</h1>`,
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.body}">${escapeHtml(parts.body)}</p>`,
    quoteHtml,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border:1px solid ${COLOR.border};border-radius:6px;margin-bottom:24px;text-align:start"><tbody>${rowHtml}</tbody></table>`,
    `<a href="${escapeHtml(parts.ticketUrl)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-size:15px;line-height:20px;font-weight:500;text-decoration:none">${withReference(escapeHtml(parts.action), parts.reference)}</a>`,
    `<p style="margin:28px 0 0 0;padding-top:16px;border-top:1px solid ${COLOR.divider};font-size:12px;line-height:18px;color:${COLOR.muted}">${escapeHtml(parts.why)} <a href="${escapeHtml(parts.settingsUrl)}" style="color:${COLOR.primary}">${escapeHtml(parts.settings)}</a>.</p>`,
    `<p style="margin:4px 0 0 0;font-size:12px;line-height:18px;color:${COLOR.muted}">${escapeHtml(parts.sentTo)}</p>`,
    '</td></tr></tbody></table></body></html>',
  ].join('');
};

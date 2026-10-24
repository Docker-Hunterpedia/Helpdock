import type { EmailMessage } from '@helpdock/channels';
import { createI18n, type Locale } from '@helpdock/i18n';
import {
  excerptOf,
  type NotificationDetail,
  type NotificationKind,
  type TicketPriority,
} from '@helpdock/schemas';
import { escapeHtml } from '../auth/email-templates.js';
import {
  buttonHtml,
  COLOR,
  link,
  notificationFooter,
  renderFrame,
  withReference,
} from './email-frame.js';
import { type UnsubscribeLinks, unsubscribeHeaders } from './unsubscribe-tokens.js';

/**
 * The staff notification email of the `EmailStaffNotification` artboard, in
 * the recipient's app language: what a batch of one is (M14-10, artboard
 * `Email/NotificationBatch`, "unchanged from 1.0 apart from the footer").
 * Every sentence is in the `email` catalogs under `staffNotification`; this
 * file only decides the shape inside the shared frame of `email-frame.ts`.
 */

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
  /** M14-11. Signed for this recipient: the footer's page and the header's one-click address. */
  readonly unsubscribe: UnsubscribeLinks;
}

const isSla = (kind: NotificationKind): boolean =>
  kind === 'sla_warning' || kind === 'sla_breached' || kind === 'escalated';

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
  const action =
    kind === 'mentioned' ? t('action.reply') : t('action.open', { reference: ticket.reference });
  const footer = notificationFooter({
    locale,
    appUrl: input.appUrl,
    email: input.to.address,
    unsubscribe: input.unsubscribe,
  });

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
    footer.text,
  ].join('\n');

  const html = renderFrame({
    locale,
    brand: t('brand'),
    inner: renderInner({
      kind,
      kicker,
      heading,
      body,
      quote,
      rows,
      reference: ticket.reference,
      action,
      ticketUrl,
    }),
    footer,
  });

  return {
    to: { address: input.to.address, name: input.to.name },
    subject,
    text,
    html,
    locale,
    headers: unsubscribeHeaders(input.unsubscribe),
  };
};

interface HtmlParts {
  readonly kind: NotificationKind;
  readonly kicker: string;
  readonly heading: string;
  readonly body: string;
  readonly quote: { readonly label: string; readonly text: string } | null;
  readonly rows: readonly (readonly [string, string, 'reference' | 'priority' | 'plain'])[];
  readonly reference: string;
  readonly action: string;
  readonly ticketUrl: string;
}

const renderInner = (parts: HtmlParts): string => {
  const { rows } = parts;
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
    `<div style="font-size:12px;line-height:16px;font-weight:500;color:${kickerColor};margin-bottom:6px">${escapeHtml(parts.kicker)}</div>`,
    `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:600">${withReference(escapeHtml(parts.heading), parts.reference)}</h1>`,
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.body}">${escapeHtml(parts.body)}</p>`,
    quoteHtml,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border:1px solid ${COLOR.border};border-radius:6px;margin-bottom:24px;text-align:start"><tbody>${rowHtml}</tbody></table>`,
    buttonHtml(parts.ticketUrl, withReference(escapeHtml(parts.action), parts.reference)),
  ].join('');
};

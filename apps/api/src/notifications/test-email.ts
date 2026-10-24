import type { EmailMessage } from '@helpdock/channels';
import { createI18n, type Locale } from '@helpdock/i18n';
import { escapeHtml } from '../auth/email-templates.js';
import { buttonHtml, COLOR, link, notificationFooter, renderFrame } from './email-frame.js';
import { type UnsubscribeLinks, unsubscribeHeaders } from './unsubscribe-tokens.js';

/**
 * "Send me a test email" (M14-11): the frame, the footer and the headers of a
 * real notification email around one sentence saying it is a test, so what the
 * person receives is what the real ones look like. No ticket, no names.
 */

export interface TestEmailInput {
  readonly locale: Locale;
  readonly to: { readonly address: string; readonly name: string };
  readonly appUrl: string;
  readonly unsubscribe: UnsubscribeLinks;
}

export const renderTestEmail = (input: TestEmailInput): EmailMessage => {
  const { locale } = input;
  const i18n = createI18n({ lng: locale });
  const t = i18n.getFixedT(locale, 'email', 'notificationTest');
  const brand = i18n.getFixedT(locale, 'email', 'staffNotification')('brand');
  const settingsUrl = link(input.appUrl, '/settings/account/notifications');
  const footer = notificationFooter({
    locale,
    appUrl: input.appUrl,
    email: input.to.address,
    unsubscribe: input.unsubscribe,
  });

  const inner = [
    `<div style="font-size:12px;line-height:16px;font-weight:500;color:${COLOR.kicker};margin-bottom:6px">${escapeHtml(t('kicker'))}</div>`,
    `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:600">${escapeHtml(t('heading'))}</h1>`,
    `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.body}">${escapeHtml(t('body'))}</p>`,
    buttonHtml(settingsUrl, escapeHtml(t('action'))),
  ].join('');

  return {
    to: { address: input.to.address, name: input.to.name },
    subject: t('subject'),
    text: [
      t('kicker'),
      t('heading'),
      '',
      t('body'),
      '',
      `${t('action')}: ${settingsUrl}`,
      '',
      footer.text,
    ].join('\n'),
    html: renderFrame({ locale, brand, inner, footer }),
    locale,
    headers: unsubscribeHeaders(input.unsubscribe),
  };
};

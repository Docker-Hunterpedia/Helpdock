import { createI18n, dir, type Locale } from '@helpdock/i18n';
import { fontFallbacks } from '@helpdock/ui/resolve';
import { escapeHtml } from '../auth/email-templates.js';
import type { UnsubscribeLinks } from './unsubscribe-tokens.js';

/**
 * What every staff notification email shares, single or batched (artboards
 * `EmailStaffNotification` and `Email/NotificationBatch`): one 600 px table
 * with inline styles and no remote images, like every email Helpdock sends
 * (`auth/email-templates.ts` says why), the product mark on top, and the
 * footer that says why the email came and where to change that.
 *
 * `dir` and `lang` are set on the table, because an Arabic message laid out
 * left to right is broken. Names, subjects and references stay in the
 * language they were written in, isolated with `<bdi>`.
 */

/** The artboards' colours, as the literal values mail clients need. */
export const COLOR = {
  page: '#F7F5F0',
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

export const MONO = fontFallbacks.mono;

export const link = (appUrl: string, path: string): string => new URL(path, appUrl).toString();

/** A ticket reference as the artboards draw it: monospaced and isolated. */
export const referenceHtml = (reference: string): string =>
  `<bdi style="font-family:${escapeHtml(MONO)}">${escapeHtml(reference)}</bdi>`;

/** Wraps every occurrence of the ticket reference in already escaped text. */
export const withReference = (escaped: string, reference: string): string =>
  escaped.replaceAll(escapeHtml(reference), referenceHtml(reference));

export interface Footer {
  readonly text: string;
  readonly html: string;
}

/**
 * "You get these because of your notification settings. Change them, or
 * unsubscribe from notification emails." and who it was sent to. The
 * unsubscribe link opens a confirmation page: following it changes nothing.
 */
export const notificationFooter = ({
  locale,
  appUrl,
  email,
  unsubscribe,
}: {
  readonly locale: Locale;
  readonly appUrl: string;
  readonly email: string;
  readonly unsubscribe: UnsubscribeLinks;
}): Footer => {
  const i18n = createI18n({ lng: locale });
  const t = i18n.getFixedT(locale, 'email', 'notificationBatch');
  const sentTo = i18n.getFixedT(locale, 'email', 'staffNotification')('sentTo', { email });
  const settingsUrl = link(appUrl, '/me/notifications');
  const why = t('footer.why');
  const change = t('footer.change');
  const unsubscribeLabel = t('footer.unsubscribe');

  return {
    text: [
      `${why} ${change}: ${settingsUrl}`,
      `${unsubscribeLabel}: ${unsubscribe.page}`,
      sentTo,
    ].join('\n'),
    html: [
      `<p style="margin:28px 0 0 0;padding-top:16px;border-top:1px solid ${COLOR.divider};font-size:12px;line-height:18px;color:${COLOR.muted}">${escapeHtml(why)} <a href="${escapeHtml(settingsUrl)}" style="color:${COLOR.primary}">${escapeHtml(change)}</a>${escapeHtml(t('footer.or'))}<a href="${escapeHtml(unsubscribe.page)}" style="color:${COLOR.primary}">${escapeHtml(unsubscribeLabel)}</a>.</p>`,
      `<p style="margin:4px 0 0 0;font-size:12px;line-height:18px;color:${COLOR.muted}">${escapeHtml(sentTo)}</p>`,
    ].join(''),
  };
};

/** The page, the card and the product mark around `inner`, with the footer last. */
export const renderFrame = ({
  locale,
  brand,
  inner,
  footer,
}: {
  readonly locale: Locale;
  readonly brand: string;
  readonly inner: string;
  readonly footer: Footer;
}): string =>
  [
    `<!doctype html><html lang="${locale}" dir="${dir(locale)}"><body style="margin:0;padding:24px;background:${COLOR.page}">`,
    `<table role="presentation" dir="${dir(locale)}" lang="${locale}" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;margin:0 auto;border-collapse:separate;background:${COLOR.surface};border:1px solid ${COLOR.border};border-radius:10px;font-family:${escapeHtml(fontFallbacks.sans)};color:${COLOR.text}">`,
    '<tbody><tr><td style="padding:28px 32px 32px 32px;text-align:start">',
    `<div style="margin-bottom:24px"><span style="display:inline-block;width:28px;height:28px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-weight:600;font-size:14px;line-height:28px;text-align:center">H</span> <span style="font-weight:600;font-size:14px">${escapeHtml(brand)}</span></div>`,
    inner,
    footer.html,
    '</td></tr></tbody></table></body></html>',
  ].join('');

/** The primary button. */
export const buttonHtml = (href: string, labelHtml: string): string =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:${COLOR.primary};color:#FFFFFF;font-size:15px;line-height:20px;font-weight:500;text-decoration:none">${labelHtml}</a>`;

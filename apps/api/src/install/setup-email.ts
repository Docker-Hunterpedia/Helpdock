import type { EmailMessage } from '@helpdock/channels';
import { createI18n, dir, type Locale } from '@helpdock/i18n';
import { escapeHtml } from '../auth/email-templates.js';

/**
 * The message "Send a test email" sends. It carries no link and no token — it
 * exists to prove that a relay accepts a message from this install — so it does
 * not reuse `renderAuthEmail`'s layout, which is built around a button.
 *
 * Every sentence comes from the `email` catalogs, in the locale the admin chose
 * on step 1 (packages/i18n README).
 */

const APP_NAME = 'Helpdock';

export interface RenderSmtpTestEmailInput {
  readonly to: string;
  readonly name: string;
  readonly host: string;
  readonly locale: Locale;
}

export const renderSmtpTestEmail = ({
  to,
  name,
  host,
  locale,
}: RenderSmtpTestEmailInput): EmailMessage => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'email');

  const subject = t('smtpTest.subject', { appName: APP_NAME });
  const heading = t('smtpTest.heading');
  const body = t('smtpTest.body', { host });
  const signature = t('common.signature', { appName: APP_NAME });

  return {
    to: { address: to, name },
    subject,
    text: [heading, '', body, '', signature].join('\n'),
    html: [
      `<!doctype html><html lang="${locale}" dir="${dir(locale)}"><body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1b1f24">`,
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">',
      `<tr><td><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>`,
      `<p style="margin:0 0 24px;font-size:15px;line-height:1.6">${escapeHtml(body)}</p>`,
      `<p style="margin:0;font-size:12px;color:#5b636d">${escapeHtml(signature)}</p>`,
      '</td></tr></table></body></html>',
    ].join(''),
    locale,
  };
};

import type { EmailMessage } from '@helpdock/channels';
import { createI18n, dir, type Locale } from '@helpdock/i18n';

/**
 * Every message the api puts in a person's inbox before they have a session:
 * the sign-in link and the password reset of M0-05, and the staff invite of
 * M0-06. They are rendered from the `email` catalogs in `@helpdock/i18n`. No
 * sentence is written here: catalogs hold every string a person reads, in `en`
 * and `ar`, and this file only decides the shape around them (packages/i18n
 * README).
 *
 * The HTML is one table and inline styles on purpose. Mail clients strip
 * `<style>` blocks, ignore most of CSS and have no `:root`, so the markup that
 * survives is the markup from 2005. It also sets `dir`, because an Arabic
 * message laid out left to right is as broken as an Arabic screen would be.
 */

const APP_NAME = 'Helpdock';

/**
 * Every value that reaches the HTML goes through this. The link is built by
 * the api and the address came from the `users` table, so neither is attacker
 * chosen today — but a template that only escapes when it remembers to is a
 * template that will stop escaping.
 */
export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

interface TemplateCopy {
  readonly subject: string;
  readonly heading: string;
  readonly body: string;
  readonly action: string;
  readonly expiry: string;
  readonly ignore: string;
  readonly linkFallback: string;
  readonly signature: string;
}

const layout = ({
  copy,
  url,
  locale,
}: {
  readonly copy: TemplateCopy;
  readonly url: string;
  readonly locale: Locale;
}): { text: string; html: string } => {
  const text = [
    copy.heading,
    '',
    copy.body,
    '',
    url,
    '',
    copy.expiry,
    copy.ignore,
    '',
    copy.signature,
  ].join('\n');

  const href = escapeHtml(url);
  const html = [
    `<!doctype html><html lang="${locale}" dir="${dir(locale)}"><body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1b1f24">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">',
    `<tr><td><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(copy.heading)}</h1>`,
    `<p style="margin:0 0 24px;font-size:15px;line-height:1.6">${escapeHtml(copy.body)}</p>`,
    `<p style="margin:0 0 24px"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#1b62f2;color:#ffffff;border-radius:8px;text-decoration:none;font-size:15px">${escapeHtml(copy.action)}</a></p>`,
    `<p style="margin:0 0 8px;font-size:13px;color:#5b636d">${escapeHtml(copy.expiry)}</p>`,
    `<p style="margin:0 0 24px;font-size:13px;color:#5b636d">${escapeHtml(copy.ignore)}</p>`,
    `<p style="margin:0 0 4px;font-size:12px;color:#5b636d">${escapeHtml(copy.linkFallback)}</p>`,
    `<p style="margin:0 0 24px;font-size:12px;color:#5b636d;word-break:break-all"><a href="${href}" style="color:#1b62f2">${href}</a></p>`,
    `<p style="margin:0;font-size:12px;color:#5b636d">${escapeHtml(copy.signature)}</p>`,
    '</td></tr></table></body></html>',
  ].join('');

  return { text, html };
};

export type AuthEmailKind = 'magicLink' | 'passwordReset' | 'invite';

export interface RenderAuthEmailInput {
  readonly kind: AuthEmailKind;
  readonly to: string;
  readonly name?: string;
  readonly url: string;
  readonly locale: Locale;
  /**
   * How long the link lasts, as a number the catalog phrases. The **unit
   * belongs to the key**: `magicLink.expiry` and `passwordReset.expiry` count
   * minutes, `invite.expiry` counts days. Naming it `ttlMinutes` would have
   * made the invite's seven read as seven minutes at every call site.
   */
  readonly expiresIn: number;
  /**
   * Extra interpolation for the kinds whose sentences name more than the
   * recipient — the invite says who invited them, to which brand, as what.
   */
  readonly values?: Readonly<Record<string, string>>;
}

export const renderAuthEmail = ({
  kind,
  to,
  name,
  url,
  locale,
  expiresIn,
  values = {},
}: RenderAuthEmailInput): EmailMessage => {
  // One instance per message: it is cheap, the catalogs are already in memory,
  // and a shared instance whose language is switched per message is a race the
  // help center would eventually lose too.
  const t = createI18n({ lng: locale }).getFixedT(locale, 'email');
  const common = { appName: APP_NAME, email: to, ...values };

  const copy: TemplateCopy = {
    subject: t(`${kind}.subject`, common),
    heading: t(`${kind}.heading`, common),
    body: t(`${kind}.body`, common),
    action: t(`${kind}.action`),
    expiry: t(`${kind}.expiry`, { ...common, count: expiresIn }),
    ignore: t(`${kind}.ignore`),
    linkFallback: t('common.linkFallback'),
    signature: t('common.signature', { appName: APP_NAME }),
  };

  const { text, html } = layout({ copy, url, locale });

  return {
    to: { address: to, ...(name === undefined ? {} : { name }) },
    subject: copy.subject,
    text,
    html,
    locale,
  };
};

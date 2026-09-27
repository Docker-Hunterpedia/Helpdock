/**
 * The customer email of artboard `EmailCustomer` (M2-05, M2-06): one 600 px
 * column, table-based HTML with inline styles, and a plain-text part with the
 * same words. Agent replies and both auto-replies share it; what differs is
 * whether it carries the reply marker, a signature and the automatic-reply note.
 *
 * It takes every sentence as input and writes none itself: the api renders
 * them from the `email` catalogs in the customer's language (packages/i18n).
 * The HTML is table-based because mail clients strip `<style>`, ignore most of
 * CSS and have no custom properties, so colours are the DESIGN.md token values
 * written out. `dir` is on the outermost element because an Arabic message laid
 * out left to right is as broken as an Arabic screen would be.
 */

export interface CustomerEmailReference {
  /** "Request" / "رقم الطلب". */
  readonly label: string;
  /** `[HD-1042]`, set in `<bdi>` so it reads left to right inside Arabic. */
  readonly token: string;
  readonly subject: string;
  /** "Reply to this email to add to your request." */
  readonly hint: string;
}

export interface CustomerEmailLayout {
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
  readonly brandName: string;
  /** The brand's accent for the square; the DESIGN default when the brand has none. */
  readonly accent?: string;
  /** "##- Please type your reply above this line -##". Null on auto-replies. */
  readonly replyMarker: string | null;
  /** Already sanitised: an agent's reply is stored sanitised (REQUIREMENTS §5.1). */
  readonly bodyHtml: string;
  readonly bodyText: string;
  /** Plain text, one line per line. */
  readonly signature: string | null;
  /** "This is an automatic reply…". */
  readonly note: string | null;
  readonly reference: CustomerEmailReference;
  /** "You are receiving this because you contacted Helpdock support." */
  readonly footer: string;
  /** The help center, when the brand has one; drawn beside the brand name. */
  readonly helpCenterUrl?: string | undefined;
}

const DEFAULT_ACCENT = '#0F766E';
const HEX = /^#[0-9a-f]{6}$/i;

const COLOURS = {
  page: '#EFECE5',
  surface: '#FFFFFF',
  subtle: '#F7F5F0',
  border: '#E3DFD6',
  divider: '#EFECE5',
  text: '#16181C',
  secondary: '#5C564C',
  body: '#403C35',
  muted: '#7D7669',
} as const;

const FONT = "'IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif";
const FONT_AR = "'IBM Plex Sans Arabic','IBM Plex Sans',ui-sans-serif,system-ui,sans-serif";
const MONO = "'IBM Plex Mono',ui-monospace,monospace";

export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/g;

/**
 * Escapes a line of plain text and makes its links clickable, as the signature
 * form promises. The URL is matched in the escaped text, where `&` is already
 * `&amp;`, so the href it produces is valid HTML without escaping twice.
 */
export const linkify = (text: string): string =>
  escapeHtml(text).replace(
    URL_PATTERN,
    (url) => `<a href="${url}" style="color:${DEFAULT_ACCENT}">${url}</a>`,
  );

/** Plain text as paragraphs: a blank line starts a new one, a newline is a `<br>`. */
export const paragraphsToHtml = (text: string): string =>
  text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px 0">${paragraph.split(/\r?\n/).map(linkify).join('<br>')}</p>`,
    )
    .join('');

const signatureLines = (signature: string | null): readonly string[] =>
  (signature ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

const row = (content: string, style: string): string =>
  `<tr><td style="${style}">${content}</td></tr>`;

export const renderCustomerEmail = (
  layout: CustomerEmailLayout,
): { html: string; text: string } => {
  const accent =
    layout.accent !== undefined && HEX.test(layout.accent) ? layout.accent : DEFAULT_ACCENT;
  const font = layout.dir === 'rtl' ? FONT_AR : FONT;
  const lines = signatureLines(layout.signature);
  const initial = escapeHtml(Array.from(layout.brandName.trim())[0]?.toUpperCase() ?? 'H');
  const brandName = escapeHtml(layout.brandName);
  const reference = layout.reference;

  const signatureHtml =
    lines.length === 0
      ? ''
      : `<div style="margin-top:4px;padding-top:12px;border-top:1px solid ${COLOURS.divider};font-size:14px;line-height:20px;color:${COLOURS.body}">${lines
          .map((line, index) =>
            index === 0
              ? `<span style="font-weight:500;color:${COLOURS.text}">${linkify(line)}</span>`
              : linkify(line),
          )
          .join('<br>')}</div>`;

  const noteHtml =
    layout.note === null
      ? ''
      : `<p style="margin:0;font-size:12px;line-height:16px;color:${COLOURS.secondary}">${escapeHtml(layout.note)}</p>`;

  const helpCenter =
    layout.helpCenterUrl === undefined
      ? ''
      : ` · <a href="${escapeHtml(layout.helpCenterUrl)}" style="color:${accent}"><bdi>${escapeHtml(layout.helpCenterUrl.replace(/^https?:\/\//, ''))}</bdi></a>`;

  const html = [
    `<!doctype html><html lang="${escapeHtml(layout.locale)}" dir="${layout.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>`,
    `<body style="margin:0;padding:24px 0;background:${COLOURS.page};font-family:${font};color:${COLOURS.text}">`,
    `<table role="presentation" dir="${layout.dir}" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;margin:0 auto;background:${COLOURS.surface};border:1px solid ${COLOURS.border};border-radius:10px;border-collapse:separate">`,
    layout.replyMarker === null
      ? ''
      : row(
          escapeHtml(layout.replyMarker),
          `padding:10px 32px;font-size:12px;line-height:16px;color:${COLOURS.muted};border-bottom:1px solid ${COLOURS.divider}`,
        ),
    row(
      `<span style="display:inline-block;width:32px;height:32px;line-height:32px;border-radius:6px;background:${accent};color:#FFFFFF;font-weight:600;text-align:center;vertical-align:middle">${initial}</span>&nbsp;&nbsp;<span style="font-weight:600;font-size:16px;vertical-align:middle">${brandName}</span>`,
      `padding:20px 32px;border-bottom:1px solid ${COLOURS.divider}`,
    ),
    row(
      `${layout.bodyHtml}${signatureHtml}${noteHtml}`,
      'padding:24px 32px;font-size:16px;line-height:24px',
    ),
    row(
      `<div style="padding:12px 16px;border-radius:6px;background:${COLOURS.subtle};font-size:13px;line-height:20px;color:${COLOURS.body}"><span style="font-weight:500">${escapeHtml(reference.label)}</span> <bdi style="font-family:${MONO}">${escapeHtml(reference.token)}</bdi> · ${escapeHtml(reference.subject)}<br><span style="color:${COLOURS.secondary}">${escapeHtml(reference.hint)}</span></div>`,
      'padding:0 32px',
    ),
    row(
      `${brandName}${helpCenter}<br>${escapeHtml(layout.footer)}`,
      `padding:20px 32px 24px 32px;font-size:12px;line-height:16px;color:${COLOURS.secondary}`,
    ),
    '</table></body></html>',
  ].join('');

  const text = [
    ...(layout.replyMarker === null ? [] : [layout.replyMarker, '']),
    layout.bodyText.trim(),
    ...(lines.length === 0 ? [] : ['', '-- ', ...lines]),
    ...(layout.note === null ? [] : ['', layout.note]),
    '',
    `${reference.label} ${reference.token} · ${reference.subject}`,
    reference.hint,
    '',
    layout.helpCenterUrl === undefined
      ? layout.brandName
      : `${layout.brandName} · ${layout.helpCenterUrl}`,
    layout.footer,
  ].join('\n');

  return { html, text };
};

import { escapeHtml } from './customer-layout.js';

/**
 * The body of the satisfaction survey email (M8-06, artboard `Email/CSAT-EN-AR`,
 * DESIGN §6.3's CustomerEmail survey variant), poured into the customer layout
 * in place of a reply's body.
 *
 * Five link cells, 1 at the inline start in both languages because the row
 * takes the table's `dir`. Each link only **opens** the rating page with its
 * score pressed; nothing is recorded until the customer presses Send, so a mail
 * scanner that follows every link in a message cannot cast a rating.
 *
 * Like the layout, it writes no sentence of its own: every word arrives from
 * the `email` catalog in the customer's language.
 */

export interface CsatSurveyChoice {
  readonly rating: number;
  /** "Very bad" … "Excellent". */
  readonly word: string;
  /** The rating page with this score pressed. */
  readonly href: string;
  /** "Rate 4 out of 5, Good". */
  readonly label: string;
}

export interface CsatSurveyBody {
  /** "Hi Mona,". */
  readonly greeting: string;
  /** "Lina closed your request HD-1042 today. We would like to know how it went." */
  readonly intro: string;
  /** The ticket reference inside `intro`, set in mono and `bdi`. */
  readonly reference: string;
  /** "How would you rate the help you received?", the message's h1. */
  readonly question: string;
  readonly choices: readonly CsatSurveyChoice[];
  /** "Choose a number to open the survey page with it already selected…". */
  readonly hint: string;
}

const COLOURS = {
  text: '#16181C',
  secondary: '#5C564C',
  strong: '#CFC9BD',
} as const;

const MONO = "'IBM Plex Mono',ui-monospace,monospace";

const introHtml = (intro: string, reference: string): string => {
  const escaped = escapeHtml(intro);
  const token = escapeHtml(reference);
  const at = escaped.indexOf(token);

  return at === -1
    ? escaped
    : `${escaped.slice(0, at)}<bdi style="font-family:${MONO}">${token}</bdi>${escaped.slice(at + token.length)}`;
};

const cell = (choice: CsatSurveyChoice): string =>
  `<td width="20%" style="padding:0 2px"><a href="${escapeHtml(choice.href)}" aria-label="${escapeHtml(choice.label)}" style="display:block;padding:10px 4px;border:1px solid ${COLOURS.strong};border-radius:6px;text-align:center;text-decoration:none;color:${COLOURS.text}"><span style="display:block;font-family:${MONO};font-size:20px;line-height:28px;font-weight:500">${String(choice.rating)}</span><span style="display:block;font-size:12px;line-height:16px;color:${COLOURS.secondary}">${escapeHtml(choice.word)}</span></a></td>`;

export const renderCsatSurveyBody = (
  body: CsatSurveyBody,
): { readonly bodyHtml: string; readonly bodyText: string } => {
  const widest = Math.max(
    ...body.choices.map((choice) => `${choice.rating} · ${choice.word}`.length),
  );

  const bodyHtml = [
    `<p style="margin:0 0 16px 0">${escapeHtml(body.greeting)}</p>`,
    `<p style="margin:0 0 16px 0">${introHtml(body.intro, body.reference)}</p>`,
    `<h1 style="margin:0 0 16px 0;font-size:20px;line-height:28px;font-weight:600">${escapeHtml(body.question)}</h1>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px 0;border-collapse:collapse"><tr>${body.choices.map(cell).join('')}</tr></table>`,
    `<p style="margin:0 0 16px 0;font-size:14px;line-height:20px">${escapeHtml(body.hint)}</p>`,
  ].join('');

  const bodyText = [
    body.greeting,
    '',
    body.intro,
    '',
    body.question,
    '',
    ...body.choices.map(
      (choice) => `${`${choice.rating} · ${choice.word}`.padEnd(widest + 2)}${choice.href}`,
    ),
  ].join('\n');

  return { bodyHtml, bodyText };
};

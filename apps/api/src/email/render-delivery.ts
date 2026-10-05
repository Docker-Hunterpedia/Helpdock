import {
  AUTO_REPLY_HEADERS,
  type EmailMessage,
  escapeHtml,
  paragraphsToHtml,
  renderCsatSurveyBody,
  renderCustomerEmail,
} from '@helpdock/channels';
import type { EmailDelivery } from '@helpdock/db';
import { type AutoReplyTemplates, CSAT_TOKEN_TTL_DAYS } from '@helpdock/schemas';
import type { SendFacts } from './email.repository.js';
import {
  csatSurveyCopy,
  customerCopy,
  fillPlaceholders,
  firstNameOf,
  transcriptCopy,
} from './email-copy.js';

/**
 * One delivery row, rendered to the message Nodemailer sends (artboard
 * `EmailCustomer`). An agent's reply carries the reply marker, the body as the
 * agent wrote it (stored sanitised), their signature in the customer's
 * language, and "Agent via Department" as the display name; an auto-reply
 * carries the Admin's template, the automatic-reply note and M2-06's
 * loop-protection headers instead.
 *
 * Rendered when sent rather than when queued, from the message and the ticket
 * as they are then. The addressing and the `Message-ID` are the row's, frozen
 * at creation, so a retry is the same message to the same people.
 */

export interface RenderInput {
  readonly delivery: EmailDelivery;
  readonly facts: SendFacts;
  readonly thread: {
    readonly inReplyTo: string | undefined;
    readonly references: readonly string[];
  };
  /** The brand's auto-reply wording; only read for an auto-reply. */
  readonly templates: (kind: 'acknowledgment' | 'outOfHours') => AutoReplyTemplates;
  /** M8-06: what a survey email links to and names. Only read for a `csat` delivery. */
  readonly survey?: CsatSurveyEmail | undefined;
}

export interface CsatSurveyEmail {
  /** The rating page with each score pressed, 1 first. */
  readonly links: readonly string[];
  /** The first name of the agent who closed the ticket, when the page may name them. */
  readonly closedBy: string | null;
}

/** RFC 3834: a survey is sent by the system, not in reply to anything the customer sent. */
const SURVEY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Auto-Submitted': 'auto-generated',
});

/** The signature in the customer's language; an Arabic reply falls back to the English one. */
export const signatureFor = (author: SendFacts['author'], locale: 'en' | 'ar'): string | null => {
  if (author === null) {
    return null;
  }
  const preferred = locale === 'ar' ? author.signatureAr : author.signatureEn;
  const chosen = preferred === null || preferred.trim() === '' ? author.signatureEn : preferred;

  return chosen === null || chosen.trim() === '' ? null : chosen;
};

export const renderDelivery = (input: RenderInput): EmailMessage =>
  input.delivery.kind === 'csat' ? renderSurvey(input) : renderMessage(input);

const renderMessage = ({ delivery, facts, thread, templates }: RenderInput): EmailMessage => {
  const locale = delivery.locale;
  const copy = customerCopy(locale, facts.brandName);
  const auto = delivery.kind !== 'reply';
  const transcript = delivery.kind === 'transcript';

  const content = transcript
    ? transcriptContent(delivery, facts)
    : auto
      ? autoReplyContent(delivery, facts, templates)
      : {
          subject: copy.replySubject(facts.ticket.reference, facts.ticket.subject),
          bodyHtml: facts.message?.bodyHtml ?? '',
          bodyText: facts.message?.bodyText ?? '',
        };

  const { html, text } = renderCustomerEmail({
    locale,
    dir: copy.dir,
    brandName: facts.brandName,
    replyMarker: auto ? null : copy.replyMarker,
    bodyHtml: content.bodyHtml,
    bodyText: content.bodyText,
    signature: auto ? null : signatureFor(facts.author, locale),
    note: transcript
      ? transcriptCopy(locale, { brandName: facts.brandName, reference: facts.ticket.reference })
          .note
      : auto
        ? copy.autoReplyNote
        : null,
    reference: {
      label: copy.referenceLabel,
      token: `[${facts.ticket.reference}]`,
      subject: facts.ticket.subject,
      hint: auto ? copy.autoReplyHint : copy.replyHint,
    },
    footer: copy.footer,
  });

  const displayName =
    !auto && facts.author !== null
      ? copy.fromVia(facts.author.name, delivery.fromName)
      : delivery.fromName;

  return {
    from: { address: delivery.fromAddress, name: displayName },
    to: { address: delivery.toAddress, ...(delivery.toName ? { name: delivery.toName } : {}) },
    cc: delivery.ccAddresses.map((address) => ({ address })),
    ...(delivery.replyTo === null ? {} : { replyTo: delivery.replyTo }),
    subject: content.subject,
    text,
    html,
    locale,
    messageId: delivery.messageId,
    ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
    references: [...thread.references],
    // A transcript is asked for, not automatic; RFC 3834's headers are for
    // mail nobody asked for.
    ...(auto && !transcript ? { headers: AUTO_REPLY_HEADERS } : {}),
  };
};

/**
 * M8-06 (`Email/CSAT-EN-AR`): the question as the h1, five link cells, the
 * once-only validity line as the note. No reply marker — it asks for a click —
 * though a reply still threads into the request by its reference.
 */
const renderSurvey = ({ delivery, facts, thread, survey }: RenderInput): EmailMessage => {
  if (survey === undefined) {
    throw new Error(`The survey email ${delivery.id} was rendered without its survey.`);
  }
  const locale = delivery.locale;
  const copy = customerCopy(locale, facts.brandName);
  const words = csatSurveyCopy(locale, {
    reference: facts.ticket.reference,
    contactName: delivery.toName ?? facts.contactName,
    closedBy: survey.closedBy,
    days: CSAT_TOKEN_TTL_DAYS,
  });
  const body = renderCsatSurveyBody({
    greeting: words.greeting,
    intro: words.intro,
    reference: facts.ticket.reference,
    question: words.question,
    choices: survey.links.map((href, index) => ({
      rating: index + 1,
      word: words.words[index] ?? '',
      href,
      label: words.choice(index + 1),
    })),
    hint: words.hint,
  });
  const { html, text } = renderCustomerEmail({
    locale,
    dir: copy.dir,
    brandName: facts.brandName,
    replyMarker: null,
    bodyHtml: body.bodyHtml,
    bodyText: body.bodyText,
    signature: null,
    note: words.note,
    reference: {
      label: copy.referenceLabel,
      token: `[${facts.ticket.reference}]`,
      subject: facts.ticket.subject,
      hint: copy.replyHint,
    },
    footer: copy.footer,
  });

  return {
    from: { address: delivery.fromAddress, name: delivery.fromName },
    to: { address: delivery.toAddress, ...(delivery.toName ? { name: delivery.toName } : {}) },
    cc: [],
    ...(delivery.replyTo === null ? {} : { replyTo: delivery.replyTo }),
    subject: words.subject,
    text,
    html,
    locale,
    messageId: delivery.messageId,
    ...(thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo }),
    references: [...thread.references],
    headers: SURVEY_HEADERS,
  };
};

const autoReplyContent = (
  delivery: EmailDelivery,
  facts: SendFacts,
  templates: RenderInput['templates'],
): { subject: string; bodyHtml: string; bodyText: string } => {
  const kind = delivery.kind === 'out_of_hours' ? 'outOfHours' : 'acknowledgment';
  const template = templates(kind)[delivery.locale];
  const values = {
    ticketNumber: facts.ticket.reference,
    contactFirstName: firstNameOf(delivery.toName ?? facts.contactName, delivery.locale),
    departmentName: facts.departmentName,
    brandName: facts.brandName,
  };
  const body = fillPlaceholders(template.body, values);

  return {
    subject: fillPlaceholders(template.subject, values),
    bodyHtml: paragraphsToHtml(body),
    bodyText: body,
  };
};

/**
 * M4-08. The conversation as a visitor saw it, one paragraph per message,
 * escaped rather than rendered: an agent's reply is sent as its text, so the
 * mail carries no markup and no link of ours (DOMAIN-RULES §4.1: "the email
 * contains no links that grant access").
 */
const transcriptContent = (
  delivery: EmailDelivery,
  facts: SendFacts,
): { subject: string; bodyHtml: string; bodyText: string } => {
  const copy = transcriptCopy(delivery.locale, {
    brandName: facts.brandName,
    reference: facts.ticket.reference,
  });
  const time = new Intl.DateTimeFormat(delivery.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const lines = facts.transcript.map((line) => ({
    who: line.from === 'visitor' ? copy.you : (line.agentName ?? copy.agent),
    when: time.format(line.at),
    text: line.text,
  }));

  return {
    subject: copy.subject,
    bodyHtml: [
      `<p style="margin:0 0 16px 0">${escapeHtml(copy.intro)}</p>`,
      ...lines.map(
        (line) =>
          `<p style="margin:0 0 16px 0"><strong>${escapeHtml(line.who)}</strong> · ${escapeHtml(line.when)}<br>${line.text
            .split(/\r?\n/)
            .map(escapeHtml)
            .join('<br>')}</p>`,
      ),
    ].join(''),
    bodyText: [copy.intro, ...lines.map((line) => `${line.who} · ${line.when}\n${line.text}`)].join(
      '\n\n',
    ),
  };
};

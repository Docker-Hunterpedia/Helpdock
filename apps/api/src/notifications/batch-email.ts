import type { EmailMessage } from '@helpdock/channels';
import { createI18n, type Locale } from '@helpdock/i18n';
import { escapeHtml } from '../auth/email-templates.js';
import type { ActorLabel, BatchContent, BatchLine, TicketEvent } from './email-batch-content.js';
import {
  buttonHtml,
  COLOR,
  link,
  notificationFooter,
  referenceHtml,
  renderFrame,
} from './email-frame.js';

/**
 * A batch of several notifications, or a digest, as the
 * `Email/NotificationBatch` artboard draws it (M14-10): a heading that counts
 * what happened, *Needs you now*, then *Tickets*, folded. In the recipient's
 * language and time zone; the subject names the brand, because a person in
 * several brands gets one digest from each (owner decision D-26).
 */

export type BatchEmailKind = 'immediate' | 'hourly' | 'daily';

export interface BatchEmailInput {
  readonly kind: BatchEmailKind;
  readonly locale: Locale;
  readonly timeZone: string;
  readonly to: { readonly address: string; readonly name: string };
  readonly brandName: string;
  readonly content: BatchContent;
  readonly appUrl: string;
  /** When it is sent: the daily digest is "for" this day. */
  readonly now: Date;
}

/** Latin digits in both languages, as every artboard writes times. */
const FORMAT_TAG: Record<Locale, string> = { en: 'en-GB', ar: 'ar-u-nu-latn' };

const formatter =
  (options: Intl.DateTimeFormatOptions) =>
  (locale: Locale, timeZone: string, at: Date): string =>
    new Intl.DateTimeFormat(FORMAT_TAG[locale], { ...options, timeZone }).format(at);

const time = formatter({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const day = formatter({ weekday: 'short', day: 'numeric', month: 'short' });
const dayAndTime = formatter({
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** At most this many references are listed under a folded line; the count says the rest. */
const REFERENCES_SHOWN = 8;

type T = (key: string, options?: Record<string, unknown>) => string;

/** One prefix of the `email` catalog, typed loosely: the keys here are built from kinds. */
const translator = (locale: Locale, prefix: 'notificationBatch' | 'staffNotification'): T => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'email', prefix);
  return (key, options) => (t as unknown as T)(key, options);
};

/** The two catalogs and the language a batch is written in. */
interface Voice {
  readonly t: T;
  readonly staff: T;
  readonly locale: Locale;
}

interface RenderedLine {
  readonly reference: { readonly text: string; readonly ticketId: string } | null;
  readonly title: string;
  readonly detail: string;
}

const listOf = (locale: Locale, items: readonly string[]): string =>
  new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);

const actorsText = ({ t, locale }: Voice, actors: readonly ActorLabel[]): string =>
  actors.length === 0
    ? t('actor.someone')
    : listOf(
        locale,
        actors.map((actor) => ('name' in actor ? actor.name : t(`actor.${actor.automatic}`))),
      );

const referencesText = (references: readonly string[]): string =>
  references.length > REFERENCES_SHOWN
    ? `${references.slice(0, REFERENCES_SHOWN).join(', ')}, …`
    : references.join(', ');

const eventText = (voice: Voice, event: TicketEvent, contactName: string | null): string => {
  const { t, staff } = voice;
  const clock = staff(`clock.${event.detail.clock ?? 'unknown'}`);
  switch (event.kind) {
    case 'assigned': {
      const [first] = event.actors;
      return first !== undefined && 'automatic' in first
        ? t(`event.assigned.${first.automatic}`)
        : t('event.assigned.person', { actor: actorsText(voice, event.actors) });
    }
    case 'replied':
      return t('event.replied', { count: event.count, contact: contactName ?? staff('aContact') });
    case 'mentioned':
      return t('event.mentioned', {
        count: event.count,
        actor: actorsText(voice, event.actors),
      });
    case 'sla_warning':
      return t('event.sla_warning', { percent: String(event.detail.stepPercent ?? 0), clock });
    case 'sla_breached':
      return t('event.sla_breached', { clock });
    case 'escalated':
      return t('event.escalated', { count: event.count });
    case 'snooze_ended':
      return t('event.snooze_ended');
  }
};

const renderLine = (voice: Voice, line: BatchLine, withContact: boolean): RenderedLine => {
  const { t } = voice;
  switch (line.type) {
    case 'ticket':
      return {
        reference: { text: line.reference, ticketId: line.ticketId },
        title: line.events.map((event) => eventText(voice, event, line.contactName)).join(' · '),
        detail:
          withContact && line.contactName !== null
            ? `${line.subject} · ${line.contactName}`
            : line.subject,
      };
    case 'bulk':
      return {
        reference: null,
        title: t(`bulk.${line.kind}`, {
          count: line.references.length,
          actor: actorsText(voice, line.actors),
        }),
        detail: t('bulk.references', { references: referencesText(line.references) }),
      };
    case 'rollup':
      return {
        reference: null,
        title: t(`rollup.${line.kind}`, { count: line.ticketCount }),
        detail:
          line.kind === 'assigned' && line.actors.length > 0
            ? t('rollup.by', { actors: actorsText(voice, line.actors) })
            : referencesText(line.references),
      };
  }
};

const lineText = (line: RenderedLine): string =>
  [`${line.reference === null ? '' : `${line.reference.text} `}${line.title}`, line.detail].join(
    '\n',
  );

const lineHtml = (line: RenderedLine, appUrl: string): string => {
  const reference =
    line.reference === null
      ? ''
      : `<a href="${escapeHtml(link(appUrl, `/tickets/${encodeURIComponent(line.reference.ticketId)}`))}" style="color:${COLOR.text};text-decoration:none;font-weight:600">${referenceHtml(line.reference.text)}</a> `;

  return `<div style="padding:10px 0;border-top:1px solid ${COLOR.divider}"><div style="font-size:14px;line-height:20px;color:${COLOR.text}">${reference}<bdi>${escapeHtml(line.title)}</bdi></div><div style="font-size:12px;line-height:18px;color:${COLOR.muted}"><bdi>${escapeHtml(line.detail)}</bdi></div></div>`;
};

const sectionHtml = (
  title: string,
  color: string,
  lines: readonly RenderedLine[],
  appUrl: string,
) =>
  lines.length === 0
    ? ''
    : `<div style="margin:0 0 16px 0"><div style="font-size:12px;line-height:16px;font-weight:600;color:${color};margin-bottom:6px">${escapeHtml(title)}</div>${lines.map((line) => lineHtml(line, appUrl)).join('')}</div>`;

export const renderBatchEmail = (input: BatchEmailInput): EmailMessage => {
  const { kind, locale, timeZone, content } = input;
  const t = translator(locale, 'notificationBatch');
  const staff = translator(locale, 'staffNotification');
  const voice: Voice = { t, staff, locale };
  const brand = input.brandName;
  const since = time(locale, timeZone, content.since);

  const subject =
    kind === 'immediate'
      ? t('subject.batch', { brand, count: content.total, time: since })
      : kind === 'hourly'
        ? t('subject.hourly', { brand, count: content.total })
        : t('subject.daily', { brand, date: day(locale, timeZone, input.now) });
  const kicker = t(`kicker.${kind === 'immediate' ? 'batch' : kind}`, { brand, time: since });
  const heading =
    kind === 'immediate'
      ? new Intl.ListFormat(locale, { type: 'unit' }).format(
          content.counts.map(([counted, count]) => t(`count.${counted}`, { count })),
        )
      : t('heading.digest', {
          count: content.total,
          since: dayAndTime(locale, timeZone, content.since),
        });
  const urgentCount = content.needsYouNow.reduce(
    (sum, line) =>
      sum + (line.type === 'ticket' ? line.events.reduce((all, event) => all + event.count, 0) : 0),
    0,
  );
  const intro =
    kind === 'immediate'
      ? null
      : t('intro.line', {
          needYou: t('intro.needYou', { count: urgentCount }),
          updates: t('intro.updates', { count: content.total - urgentCount }),
          dropped: t('intro.dropped'),
        });

  const needsYouNow = content.needsYouNow.map((line) => renderLine(voice, line, true));
  const tickets = content.tickets.map((line) => renderLine(voice, line, false));
  const notificationsUrl = link(input.appUrl, '/');
  const action = t('action');
  const footer = notificationFooter({ locale, appUrl: input.appUrl, email: input.to.address });

  const text = [
    kicker,
    heading,
    ...(intro === null ? [] : ['', intro]),
    ...(needsYouNow.length === 0
      ? []
      : ['', t('section.needsYouNow'), ...needsYouNow.map(lineText)]),
    ...(tickets.length === 0 ? [] : ['', t('section.tickets'), ...tickets.map(lineText)]),
    '',
    `${action}: ${notificationsUrl}`,
    '',
    footer.text,
  ].join('\n');

  const inner = [
    `<div style="font-size:12px;line-height:16px;font-weight:500;color:${COLOR.muted};margin-bottom:6px">${escapeHtml(kicker)}</div>`,
    `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:600">${escapeHtml(heading)}</h1>`,
    intro === null
      ? ''
      : `<p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${COLOR.body}">${escapeHtml(intro)}</p>`,
    sectionHtml(t('section.needsYouNow'), COLOR.danger, needsYouNow, input.appUrl),
    sectionHtml(t('section.tickets'), COLOR.text, tickets, input.appUrl),
    `<div style="margin-top:8px">${buttonHtml(notificationsUrl, escapeHtml(action))}</div>`,
  ].join('');

  return {
    to: { address: input.to.address, name: input.to.name },
    subject,
    text,
    html: renderFrame({ locale, brand: staff('brand'), inner, footer }),
    locale,
  };
};

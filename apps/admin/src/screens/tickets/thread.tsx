import type {
  MergedTicket,
  TicketActivityEntry,
  TicketLink,
  TicketMessage,
} from '@helpdock/schemas';
import { importSourceSchema } from '@helpdock/schemas';
import { Box, Link as MuiLink } from '@mui/material';
import type { LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { ticketRoute } from '../../app/route-paths.js';
import { linkReferences } from '../../tickets/merge.js';
import type { PendingMessage } from '../../tickets/pending.js';
import { closedWithoutKeys, type ThreadItem } from '../../tickets/thread.js';
import { formatClock, formatDay } from '../../ui/format.js';
import { AiEventText } from './ai/ai-event.tsx';
import { AutoReplyMessage } from './ai/auto-reply-message.tsx';
import type { ThreadAi } from './ai/use-ticket-ai.tsx';
import { AttachmentChip, chipState } from './attachment-chip.tsx';
import { EmailMessageCard, ThreadMismatch } from './email-message-card.tsx';
import { isolate, messageTime, ticketReference, wakeTime } from './format.js';
import { ImportedCsatEvent } from './imported-csat-event.js';
import { ImportedMessageDetails } from './imported-message-details.js';
import { MergedBlock } from './merged-block.tsx';
import {
  type BubbleKind,
  MESSAGE_MAX_WIDTH,
  MessageBubble,
  PendingFooter,
  SystemEvent,
} from './message-bubble.tsx';
import type { ThreadMeta } from './meta/use-ticket-meta.tsx';
import { LocationLine, splitLocation } from './telegram/location-line.tsx';
import type { ThreadTelegram } from './telegram/use-ticket-telegram.tsx';
import { VoiceNote } from './telegram/voice-note.tsx';

/** M7-05, M7-08: what agent assist adds to a customer's message in the thread. */
export interface ThreadAssist {
  readonly brandId: string;
  /** A translation or the redacted text, drawn instead of the body; undefined for the body. */
  bodyFor(message: TicketMessage): ReactNode | undefined;
  /** The AI facts line under the body; undefined for none. */
  factsFor(message: TicketMessage): ReactNode | undefined;
}

/**
 * The thread: bubbles and system events in one column, 720 px wide at most.
 *
 * `aria-live="polite"` on the list (DESIGN §10): a reply that arrives over a
 * socket is announced, and the person reading is not interrupted mid-sentence
 * the way `assertive` would.
 */

/**
 * `t` narrowed to what this file needs. The catalog keys here are built at
 * runtime — `tickets:priority.${priority}` — so the typed `useT()` cannot check
 * them, and a component passes it through {@link translator} once rather than
 * casting at every call.
 */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface ThreadNames {
  /** The person's own display name, or null when it is somebody unknown. */
  nameFor(authorType: string, authorId: string | null): string | null;
  /** A staff member's name, and only a staff member's (M1-09's "by Lina"). */
  staffName(userId: string | null): string | null;
  /** The address or handle under a contact's name, when there is one. */
  addressFor(authorId: string | null): string | null;
  /** M14-17. A custom field's label in the viewer's language; absent where the definitions are not loaded. */
  fieldLabel?(key: string): string;
}

const BUBBLE_KIND: Record<string, BubbleKind> = {
  note: 'note',
  ai: 'ai',
};

/**
 * M1-09: what the thread needs to draw merged tickets and to link the tickets
 * a system message names. Optional, so a thread with no merge in it is drawn
 * exactly as before.
 */
export interface ThreadMerges {
  readonly ticketId: string;
  /** Every ticket merged into this one, for a chain's "into HD-1038". */
  readonly merged: readonly MergedTicket[];
  /** The tickets a system message may name and this reader can open. */
  readonly links: readonly TicketLink[];
  readonly busy: boolean;
  onUnmerge(ticketId: string): void;
  /** M2-04: opens the merge dialog searching for the ticket a stranger referenced. */
  onMergeInto?(reference: string): void;
}

export function Thread({
  items,
  names,
  now,
  merges,
  deliveryFooter,
  telegram,
  meta,
  assist,
  ai,
  onRetry,
  onDiscard,
}: {
  readonly items: readonly ThreadItem[];
  readonly names: ThreadNames;
  readonly now: number;
  readonly merges?: ThreadMerges;
  /** M2-05: under a reply that was emailed, "Not delivered · Retry" when it was not. */
  readonly deliveryFooter?: ((message: TicketMessage) => ReactNode) | undefined;
  /** M6: the "via @bot" and "Sent" lines, voice notes and locations of a Telegram thread. */
  readonly telegram?: ThreadTelegram | undefined;
  /** M10-08: the "via" and "to" lines, delivery states, quotes, stickers and stories of a WhatsApp, Messenger or Instagram thread. */
  readonly meta?: ThreadMeta | undefined;
  /** M7-05, M7-08: translations and "Show redacted" under a customer's messages. */
  readonly assist?: ThreadAssist | undefined;
  /** M7-06: the AI log behind auto-replies, for their disclosures. */
  readonly ai?: ThreadAi | undefined;
  onRetry(pending: PendingMessage): void;
  onDiscard(pending: PendingMessage): void;
}): ReactNode {
  const t = useT();
  const translate = translator(t);
  const { locale } = usePreferences();
  const end = useRef<HTMLDivElement | null>(null);
  const count = items.length;
  const pinKey = meta?.pinKey;
  // M10-08: the line that marks an unsent Instagram message is drawn on the
  // message, so it is not a second event beside it.
  const shown =
    meta === undefined
      ? items
      : items.filter((item) => item.kind !== 'message' || !meta.hides(item.message));

  // The newest message is the one somebody opened the ticket to read. The
  // count, not the items: a re-read that changes nothing must not scroll.
  // M10-08: and again when the Meta strip arrives below it, which takes room
  // from the thread after it was scrolled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the count and the pin are the triggers.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [count, pinKey]);

  return (
    <>
      <Box
        component="ol"
        aria-label={t('tickets:thread.label')}
        aria-live="polite"
        // A message, a reaction line or a failure that arrives is read; Sent,
        // Delivered and Read changing in place are not (`Admin/Ticket-Meta`, notes).
        aria-relevant="additions"
        sx={{
          listStyle: 'none',
          margin: '0 auto',
          padding: 0,
          width: '100%',
          maxWidth: MESSAGE_MAX_WIDTH,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {shown.map((item) => (
          <Box component="li" key={item.id} sx={{ display: 'flex', flexDirection: 'column' }}>
            {item.kind === 'merged' ? (
              <MergedBlock
                merged={item.merged}
                intoReference={intoReferenceOf(item.merged, merges)}
                names={names}
                now={now}
                busy={merges?.busy ?? false}
                onUnmerge={(ticketId) => {
                  merges?.onUnmerge(ticketId);
                }}
              />
            ) : item.kind === 'event' ? (
              <>
                <SystemEvent>
                  {describeEvent(item.entry, names, translate, locale, now)}
                </SystemEvent>
                <ImportedCsatEvent entry={item.entry} />
              </>
            ) : item.kind === 'message' ? (
              item.message.kind === 'system' && item.message.email?.mismatch != null ? (
                <ThreadMismatch
                  message={item.message}
                  mismatch={item.message.email.mismatch}
                  now={now}
                  {...(merges?.onMergeInto === undefined ? {} : { onMerge: merges.onMergeInto })}
                />
              ) : item.message.kind === 'system' && item.message.ai !== undefined ? (
                <SystemEvent>
                  <AiEventText
                    message={item.message}
                    ai={item.message.ai}
                    staffName={names.staffName(item.message.authorId)}
                    time={messageTime(item.message.createdAt, locale, now)}
                  />
                </SystemEvent>
              ) : item.message.ai !== undefined && item.message.authorType === 'ai' ? (
                <AutoReplyMessage
                  message={item.message}
                  ai={item.message.ai}
                  call={ai?.callFor(item.message.ai.callId)}
                  time={messageTime(item.message.createdAt, locale, now)}
                />
              ) : item.message.kind === 'system' ? (
                <SystemEvent>
                  <SystemLine icon={meta?.lineIcon(item.message)}>
                    <SystemText
                      message={item.message}
                      links={merges?.links ?? []}
                      names={names}
                      now={now}
                    />
                  </SystemLine>
                </SystemEvent>
              ) : item.message.email !== undefined && item.message.authorType === 'contact' ? (
                <EmailMessageCard
                  message={item.message}
                  email={item.message.email}
                  author={
                    names.nameFor(item.message.authorType, item.message.authorId) ??
                    item.message.email.from.name ??
                    item.message.email.from.address
                  }
                  time={messageTime(item.message.createdAt, locale, now)}
                  body={assist?.bodyFor(item.message)}
                  facts={assist?.factsFor(item.message)}
                />
              ) : (
                <SentMessage
                  message={item.message}
                  names={names}
                  now={now}
                  telegram={telegram}
                  meta={meta}
                  assist={assist}
                  footer={deliveryFooter?.(item.message) ?? null}
                />
              )
            ) : (
              <MessageBubble
                kind={item.message.kind === 'note' ? 'note' : 'staff'}
                author={t('tickets:thread.you')}
                meta={messageTime(item.message.createdAt, locale, now)}
                bodyHtml={item.message.bodyHtml}
                footer={
                  <PendingFooter
                    state={item.message.state}
                    onRetry={() => {
                      onRetry(item.message);
                    }}
                    onDiscard={() => {
                      onDiscard(item.message);
                    }}
                  />
                }
              />
            )}
          </Box>
        ))}
      </Box>
      {/* Outside the list: an `<ol>` may contain only `<li>` (WCAG 1.3.1). */}
      <div ref={end} />
    </>
  );
}

/** A line nobody wrote with its icon in front, when the platform's reaction or an unsent message has one (M10-08). */
function SystemLine({
  icon: Icon,
  children,
}: {
  readonly icon: LucideIcon | undefined;
  readonly children: ReactNode;
}): ReactNode {
  if (Icon === undefined) {
    return children;
  }

  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <Icon size={14} aria-hidden="true" />
      <span>{children}</span>
    </Box>
  );
}

/**
 * A system message, with the tickets it names linked and — when a person made
 * it — who, which is the artboard's "Messages split to HD-1043 by Lina · 14:12".
 * The api writes a system row's `author_id` as the actor's; a name is shown
 * only when that is somebody in the staff directory.
 */
function SystemText({
  message,
  links,
  names,
  now,
}: {
  readonly message: TicketMessage;
  readonly links: readonly TicketLink[];
  readonly names: ThreadNames;
  readonly now: number;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const segments = linkReferences(message.bodyText, links).map((segment, index) =>
    segment.kind === 'text' ? (
      // Segments of one sentence never reorder, so the index is their identity.
      // biome-ignore lint/suspicious/noArrayIndexKey: see above.
      <span key={index}>{segment.text}</span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: see above.
      <MuiLink key={index} component={Link} to={ticketRoute(segment.ticketId)}>
        <bdi>{segment.text}</bdi>
      </MuiLink>
    ),
  );
  const by = names.staffName(message.authorId);
  const time = messageTime(message.createdAt, locale, now);

  return (
    <>
      {segments}
      {by === null ? ` · ${time}` : ` ${t('tickets:systemBy', { name: by, time })}`}
    </>
  );
}

/** The ticket a chained merge went into, or `null` when it went into this one. */
const intoReferenceOf = (merged: MergedTicket, merges: ThreadMerges | undefined): string | null => {
  if (merges === undefined || merged.mergedIntoId === merges.ticketId) {
    return null;
  }

  const into = merges.merged.find((ticket) => ticket.id === merged.mergedIntoId);

  return into === undefined ? null : ticketReference(into);
};

/**
 * One cast, in one place. `useT()` is typed against the catalog's literal keys,
 * and the keys below are built at runtime from a priority or a `via`; widening
 * it here is what keeps every call site free of casts.
 */
export const translator = (t: ReturnType<typeof useT>): Translate => t as unknown as Translate;

const bubbleKindOf = (message: TicketMessage): BubbleKind =>
  BUBBLE_KIND[message.kind] ??
  (message.importDetails?.authorKind && message.authorType === 'system'
    ? message.importDetails.authorKind === 'agent'
      ? 'staff'
      : 'contact'
    : message.authorType === 'staff' || message.authorDisplay
      ? 'staff'
      : 'contact');

/**
 * `Mona Khalil · mona@example.com · Tue 11:48`, with the address in a `<bdi>`
 * so a Latin address inside an Arabic caption keeps its separators (DESIGN §7).
 */
const metaOf = (
  message: TicketMessage,
  names: ThreadNames,
  locale: 'en' | 'ar',
  now: number,
  telegram?: ThreadTelegram,
  meta?: ThreadMeta,
): ReactNode => {
  const address =
    telegram?.leadFor(message) ?? meta?.leadFor(message) ?? names.addressFor(message.authorId);

  return (
    <>
      {address === null || address === undefined ? null : (
        <>
          <bdi>{address}</bdi>
          <span aria-hidden="true"> · </span>
        </>
      )}
      <bdi>{messageTime(message.createdAt, locale, now)}</bdi>
      {telegram?.trailFor(message)}
      {meta?.trailFor(message)}
    </>
  );
};

/**
 * A message the api has, as a bubble. On a Telegram thread a shared location
 * is lifted out of the body into its LocationLine and a voice note is a
 * player rather than a chip (M6-03).
 */
function SentMessage({
  message,
  names,
  now,
  telegram,
  meta,
  assist,
  footer,
}: {
  readonly message: TicketMessage;
  readonly names: ThreadNames;
  readonly now: number;
  readonly telegram: ThreadTelegram | undefined;
  readonly meta: ThreadMeta | undefined;
  readonly assist: ThreadAssist | undefined;
  readonly footer: ReactNode;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  // M10-08: a quote and a story caption open a Meta customer's message, and
  // are drawn above what is left of its text.
  const content = meta?.contentFor(message);
  const html = content?.html ?? message.bodyHtml;
  const located = telegram === undefined && meta === undefined ? undefined : splitLocation(html);
  const time = messageTime(message.createdAt, locale, now);
  const author =
    (message.authorDisplay
      ? `${message.authorDisplay} · ${t(
          message.importDetails?.authorKind && message.importDetails.authorKind !== 'agent'
            ? 'tickets:thread.sourceAuthor'
            : 'tickets:thread.formerAgent',
        )}`
      : names.nameFor(message.authorType, message.authorId)) ??
    t(`tickets:thread.${message.authorType === 'ai' ? 'system' : 'contact'}`);
  const drawFile = (attachment: TicketMessage['attachments'][number]): ReactNode => {
    const fromTelegram = telegram?.attachmentFor(attachment, time);
    if (fromTelegram !== undefined) {
      return fromTelegram;
    }
    // `null` from the Meta thread is a file drawn somewhere else: a story's
    // media is the figure above the text, so it is not a chip under it too.
    const fromMeta = meta?.attachmentFor(attachment, message);
    if (fromMeta !== undefined) {
      return fromMeta;
    }

    return attachment.kind === 'audio' && attachment.status === 'ready' && assist !== undefined ? (
      // M7-09: a voice note from any channel plays, with its transcript under it.
      <VoiceNote key={attachment.id} brandId={assist.brandId} attachment={attachment} time={time} />
    ) : (
      <AttachmentChip
        key={attachment.id}
        name={attachment.originalName}
        size={attachment.size}
        state={chipState(attachment)}
      />
    );
  };
  const files = message.attachments.map(drawFile).filter((node) => node !== null);
  const label = meta?.labelFor(message, author);
  const extra =
    located === undefined && content?.after === undefined ? undefined : (
      <>
        {located === undefined ? null : <LocationLine location={located.location} />}
        {content?.after}
      </>
    );

  return (
    <MessageBubble
      kind={bubbleKindOf(message)}
      author={author}
      meta={metaOf(message, names, locale, now, telegram, meta)}
      {...(label === undefined ? {} : { label })}
      {...(content === undefined ? {} : { before: content.before })}
      bodyHtml={located?.html ?? html}
      body={assist?.bodyFor(message)}
      facts={assist?.factsFor(message)}
      footer={
        <>
          {message.importDetails ? (
            <ImportedMessageDetails details={message.importDetails} />
          ) : null}
          {footer}
        </>
      }
      {...(extra === undefined ? {} : { extra })}
      {...(files.length === 0 ? {} : { attachments: files })}
    />
  );
}

/**
 * What an activity row says in the thread. Only the fields that actually moved
 * are named, because `from`/`to` carry exactly those — "Lina changed priority
 * Medium → High via a rule" is the whole sentence, and a generic "updated the
 * ticket" is the fallback for a field this screen has no wording for yet.
 */
export const describeEvent = (
  entry: TicketActivityEntry,
  names: ThreadNames,
  t: Translate,
  locale: 'en' | 'ar',
  now: number,
): string => {
  const actor = names.nameFor(entry.actorType, entry.actorId) ?? t('tickets:event.someone');
  const moved = { ...entry.from, ...entry.to };
  const at =
    entry.action === 'ticket.imported.event'
      ? `${formatDay(entry.createdAt, locale)} ${formatClock(entry.createdAt, locale)}`
      : messageTime(entry.createdAt, locale, now);
  const via = t(`tickets:event.via.${entry.via}`);
  if (entry.action === 'ticket.imported') {
    const source = importSourceSchema.safeParse(entry.to?.source);
    const number = entry.to?.number ?? entry.to?.externalId;
    const created =
      typeof entry.to?.createdAt === 'string' && Number.isFinite(Date.parse(entry.to.createdAt))
        ? formatDay(entry.to.createdAt, locale)
        : null;
    return t(created ? 'tickets:event.importedCreated' : 'tickets:event.imported', {
      source: source.success
        ? t(`imports:sources.${source.data}`)
        : t('tickets:event.importedSource'),
      number: typeof number === 'string' ? number : '—',
      importedAt: formatDay(entry.createdAt, locale),
      createdAt: created,
    });
  }
  if (entry.action === 'ticket.imported.event') {
    const sourceEvent = entry.to?.sourceEvent;
    if (sourceEvent && typeof sourceEvent === 'object' && !Array.isArray(sourceEvent)) {
      const data = sourceEvent as Record<string, unknown>;
      const source = importSourceSchema.safeParse(data.source);
      if (data.action === 'csat.response')
        return `${t('tickets:event.importedCsat', {
          source: source.success
            ? t(`imports:sources.${source.data}`)
            : t('tickets:event.importedSource'),
        })} · ${at}`;
      const originalActor = typeof data.authorDisplay === 'string' ? data.authorDisplay : actor;
      const changes = entry.to?.changes;
      const values =
        changes && typeof changes === 'object' && !Array.isArray(changes)
          ? (changes as Record<string, unknown>)
          : {};
      const field =
        typeof values.field === 'string'
          ? values.field
          : typeof entry.from?.field === 'string'
            ? entry.from.field
            : null;
      const value = (item: unknown): string =>
        typeof item === 'string'
          ? item.slice(0, 300)
          : typeof item === 'number' || typeof item === 'boolean'
            ? String(item)
            : item === null || item === undefined
              ? '—'
              : t('tickets:event.structuredValue');
      return `${t(field ? 'tickets:event.importedChange' : 'tickets:event.importedHistory', {
        actor: originalActor,
        source: source.success
          ? t(`imports:sources.${source.data}`)
          : t('tickets:event.importedSource'),
        action: typeof data.action === 'string' ? data.action : '',
        field,
        from: value(entry.from?.value),
        to: value(values.value),
      })} · ${at}`;
    }
  }

  // M3-06: one entry for everything a macro did, "via macro Shipping delay".
  if (entry.action === 'ticket.macro_applied') {
    return `${t('macros:event.applied', { actor, name: String(entry.to?.macroName ?? '') })} · ${at}`;
  }
  // M7-05: an article drafted from this ticket, sent for approval.
  if (entry.action === 'ticket.article_proposed') {
    return `${t('tickets:event.articleProposed', { actor })} · ${at}`;
  }
  // M14-02: a snooze set or moved, and the one that ended.
  if (entry.action === 'ticket.snoozed') {
    const until = typeof entry.to?.snoozedUntil === 'string' ? entry.to.snoozedUntil : null;
    return `${t('tickets:event.snoozed', {
      actor,
      until: until === null ? '—' : isolate(wakeTime(until, locale, now)),
    })} ${via} · ${at}`;
  }
  if (entry.action === 'ticket.woke') {
    const reason = ['time', 'customer_reply', 'sla', 'status_changed', 'manual'].includes(
      String(entry.to?.reason),
    )
      ? String(entry.to?.reason)
      : 'time';
    return `${t(`tickets:event.woke.${reason}`, { actor })} · ${at}`;
  }
  // M14-26: a rule chose the mailbox replies leave from.
  if (entry.action === 'ticket.reply_mailbox.changed') {
    return `${t(
      entry.to?.replyMailboxId
        ? 'tickets:event.replyMailboxSet'
        : 'tickets:event.replyMailboxCleared',
      { actor },
    )} ${via} · ${at}`;
  }
  // M5-08: "Still need help?" from a help center article.
  if (entry.action === 'ticket.source_article') {
    return `${t('tickets:event.sourceArticle', { title: String(entry.to?.title ?? '') })} · ${at}`;
  }

  // M14-17: a close the system made through empty required-to-close fields —
  // by a rule, a merge or spam — says which. The keys are the field's own
  // spelling, the one exports and rule conditions use.
  const closedWithout = closedWithoutKeys(entry);
  if (closedWithout.length > 0) {
    const labels = closedWithout.map((key) => names.fieldLabel?.(key) ?? key);

    return `${t('tickets:event.closedWithout', {
      actor,
      fields: new Intl.ListFormat(locale, { type: 'conjunction' }).format(labels),
    })} ${via} · ${at}`;
  }

  const sentence = (): string => {
    if (entry.action === 'ticket.status.changed' || 'status' in moved) {
      return t('tickets:event.status', {
        actor,
        from: String(entry.from?.status ?? ''),
        to: String(entry.to?.status ?? ''),
      });
    }
    if ('priority' in moved) {
      return t('tickets:event.priority', {
        actor,
        from: t(`tickets:priority.${String(entry.from?.priority)}`),
        to: t(`tickets:priority.${String(entry.to?.priority)}`),
      });
    }
    if ('assigneeId' in moved) {
      return t('tickets:event.assignee', { actor });
    }
    if ('departmentId' in moved) {
      return t('tickets:event.department', { actor });
    }
    if ('subject' in moved) {
      return t('tickets:event.subject', { actor });
    }

    return t('tickets:event.generic', { actor });
  };

  return `${sentence()} ${via} · ${at}`;
};

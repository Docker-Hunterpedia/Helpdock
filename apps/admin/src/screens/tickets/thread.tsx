import type { TicketActivityEntry, TicketMessage } from '@helpdock/schemas';
import { Box } from '@mui/material';
import { type ReactNode, useEffect, useRef } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import type { PendingMessage } from '../../tickets/pending.js';
import type { ThreadItem } from '../../tickets/thread.js';
import { messageTime } from './format.js';
import {
  type BubbleKind,
  MESSAGE_MAX_WIDTH,
  MessageBubble,
  PendingFooter,
  SystemEvent,
} from './message-bubble.tsx';

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
  /** The address or handle under a contact's name, when there is one. */
  addressFor(authorId: string | null): string | null;
}

const BUBBLE_KIND: Record<string, BubbleKind> = {
  note: 'note',
  ai: 'ai',
};

export function Thread({
  items,
  names,
  now,
  onRetry,
  onDiscard,
}: {
  readonly items: readonly ThreadItem[];
  readonly names: ThreadNames;
  readonly now: number;
  onRetry(pending: PendingMessage): void;
  onDiscard(pending: PendingMessage): void;
}): ReactNode {
  const t = useT();
  const translate = translator(t);
  const { locale } = usePreferences();
  const end = useRef<HTMLDivElement | null>(null);
  const count = items.length;

  // The newest message is the one somebody opened the ticket to read. The
  // count, not the items: a re-read that changes nothing must not scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the count is the trigger.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  return (
    <>
      <Box
        component="ol"
        aria-label={t('tickets:thread.label')}
        aria-live="polite"
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
        {items.map((item) => (
          <Box component="li" key={item.id} sx={{ display: 'flex', flexDirection: 'column' }}>
            {item.kind === 'event' ? (
              <SystemEvent>{describeEvent(item.entry, names, translate, locale, now)}</SystemEvent>
            ) : item.kind === 'message' ? (
              item.message.kind === 'system' ? (
                <SystemEvent>
                  {`${item.message.bodyText} · ${messageTime(item.message.createdAt, locale, now)}`}
                </SystemEvent>
              ) : (
                <MessageBubble
                  kind={bubbleKindOf(item.message)}
                  author={
                    names.nameFor(item.message.authorType, item.message.authorId) ??
                    t(`tickets:thread.${item.message.authorType === 'ai' ? 'system' : 'contact'}`)
                  }
                  meta={metaOf(item.message, names, locale, now)}
                  bodyHtml={item.message.bodyHtml}
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

/**
 * One cast, in one place. `useT()` is typed against the catalog's literal keys,
 * and the keys below are built at runtime from a priority or a `via`; widening
 * it here is what keeps every call site free of casts.
 */
export const translator = (t: ReturnType<typeof useT>): Translate => t as unknown as Translate;

const bubbleKindOf = (message: TicketMessage): BubbleKind =>
  BUBBLE_KIND[message.kind] ?? (message.authorType === 'staff' ? 'staff' : 'contact');

/**
 * `Mona Khalil · mona@example.com · Tue 11:48`, with the address in a `<bdi>`
 * so a Latin address inside an Arabic caption keeps its separators (DESIGN §7).
 */
const metaOf = (
  message: TicketMessage,
  names: ThreadNames,
  locale: 'en' | 'ar',
  now: number,
): ReactNode => {
  const address = names.addressFor(message.authorId);

  return (
    <>
      {address === null ? null : (
        <>
          <bdi>{address}</bdi>
          <span aria-hidden="true"> · </span>
        </>
      )}
      <bdi>{messageTime(message.createdAt, locale, now)}</bdi>
    </>
  );
};

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
  const at = messageTime(entry.createdAt, locale, now);
  const via = t(`tickets:event.via.${entry.via}`);

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

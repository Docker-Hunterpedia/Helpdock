import {
  type Attachment,
  firstWordOf,
  type MetaDeliveryView,
  type MetaPlatform,
  type MetaTicketContext,
  type MetaTicketContextResponse,
  metaOpeningLine,
  type TicketMessage,
} from '@helpdock/schemas';
import { Box } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, type LucideIcon, Smile, Undo2 } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { isMetaError, metaKeys } from '../../../meta/api.js';
import { useMetaApi } from '../../../meta/context.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { PLATFORM_ICONS } from '../../admin/channels/meta/platforms.js';
import { numbering } from '../format.js';
import { ChannelIdentityRows } from './channel-identity-rows.tsx';
import { DeliveryNotice, DeliveryTrail } from './delivery-state.tsx';
import {
  classifyMetaLine,
  isSticker,
  isStoryMedia,
  quotedMessage,
  splitQuote,
  splitStory,
} from './meta-content.js';
import {
  QuoteLine,
  StickerFigure,
  StoryCaption,
  StoryFigure,
  UnsentCaption,
} from './meta-figures.tsx';
import { accountLabel, clockTime, customerHandle } from './meta-format.js';
import { stripState, type WindowRefusal } from './reply-window.js';
import { ReplyWindowStrip } from './reply-window-strip.tsx';
import { useMinuteClock } from './use-minute-clock.js';

/**
 * What the ticket view needs for its Meta half (M10-08, `Admin/Ticket-Meta`),
 * in one hook so the view only passes it along, as `useTicketTelegram` does for
 * Telegram: who the conversation is with, the thread's "via" and "to" lines and
 * delivery states, the failure strips under a reply, the ReplyWindowStrip, the
 * ChannelIdentityCard, and what the composer needs to name the recipient and to
 * hold Send while the window is closed.
 *
 * `context` is undefined while the ticket is not on a Meta channel, or no
 * conversation belongs to it, and then the view draws nothing Meta.
 */

const META_CHANNELS: ReadonlySet<string> = new Set(['whatsapp', 'messenger', 'instagram']);

const isReply = (message: TicketMessage): boolean =>
  message.kind === 'public' && message.authorType === 'staff';

/** While a reply is still being sent the thread asks again, so Sending moves on to Sent unprompted. */
const SENDING_POLL_MS = 5_000;

const LINE_ICONS: Readonly<Record<'unsent' | 'reaction' | 'unsupported', LucideIcon>> = {
  unsent: Undo2,
  reaction: Smile,
  unsupported: CircleAlert,
};

/** What the composer needs from a Meta ticket. */
export interface ComposerMeta {
  readonly platform: MetaPlatform;
  /** The customer as the recipient caption names them. */
  readonly customerName: string;
  /** Their number or `@handle`; Messenger has neither. */
  readonly handle: string | undefined;
  /** The brand's number, Page or `@handle` the reply comes from. */
  readonly account: string;
  /** "Lina · Helpdock", which the api puts first in the reply: counted with the text. '' until the brand is read. */
  readonly openingLine: string;
  /** The reply window is closed: Send holds its place, `aria-disabled`, and the strip says why. */
  readonly closed: boolean;
  /** The strip's id, which Send is described by. */
  readonly stripId: string;
}

/** What a Meta message needs drawn above its text. */
export interface MetaContent {
  /** The message's HTML without the quote and the story label it opened with. */
  readonly html: string;
  /** The story caption and figure, and the quote, in the order they open the bubble. */
  readonly before: ReactNode;
  /** Under the text: "Unsent by the customer · 10:26" on a message Instagram says the customer took back. */
  readonly after?: ReactNode;
}

export interface ThreadMeta {
  /**
   * What the strip under the thread is doing to the thread's height: it is read
   * after the thread is drawn, and takes room from it, so a thread already
   * scrolled to its end must be scrolled again when the strip arrives and when
   * a refusal adds its second line.
   */
  readonly pinKey: 'strip' | 'refused';
  /** Before a message's time: "via +1 555 0142" on the customer's, "to WhatsApp" on a reply. */
  leadFor(message: TicketMessage): ReactNode;
  /** After a reply's time: Sending, Sent, Delivered or Read. */
  trailFor(message: TicketMessage): ReactNode;
  /** A reply's accessible name carries its state: "Reply from Lina Haddad, read". */
  labelFor(message: TicketMessage, author: string): string | undefined;
  /** The quote and the story a customer's message opens with, and the mark of an unsent one. */
  contentFor(message: TicketMessage): MetaContent | undefined;
  /**
   * A line the thread leaves out: the system line that marks an unsent message
   * is drawn on the message instead, so it is not a second event beside it.
   */
  hides(message: TicketMessage): boolean;
  /** The icon of a line nobody wrote: a reaction, an unsent message, something Helpdock cannot show. */
  lineIcon(message: TicketMessage): LucideIcon | undefined;
  /** A sticker or a story's media as a figure; `null` for a file drawn elsewhere; undefined for any other file. */
  attachmentFor(attachment: Attachment, message: TicketMessage): ReactNode | null | undefined;
}

export interface TicketMeta {
  readonly context: MetaTicketContext | undefined;
  /** The brand's number, Page or `@handle`, for the header's chip. */
  readonly account: string | undefined;
  readonly thread: ThreadMeta | undefined;
  /** The ReplyWindowStrip with its margins; null for a ticket that is not on a Meta channel. */
  readonly strip: ReactNode;
  readonly composer: ComposerMeta | undefined;
  /** The ChannelIdentityCard for the details panel. */
  readonly identity: ReactNode;
  /** Under a reply: Not sent, Not delivered with Retry, a file left out. */
  deliveryFooter(message: TicketMessage): ReactNode;
  /**
   * A send that failed: true when it was the platform's reply window refusing
   * it, which the strip then says, so the caller keeps the text instead of
   * drawing "not sent".
   */
  refused(error: unknown): boolean;
  /** After a send, so the new reply's delivery shows. */
  refresh(): Promise<void>;
}

const hasQueued = (data: MetaTicketContextResponse | undefined): boolean =>
  data?.deliveries.some((delivery) => delivery.status === 'queued') ?? false;

export function useTicketMeta({
  brandId,
  ticketId,
  channel,
  customerName,
  viewerName,
  brandName,
  messages,
  authorOf,
}: {
  readonly brandId: string;
  readonly ticketId: string;
  readonly channel: string;
  /** The contact's name, or null while it is not known; blank is "the customer". */
  readonly customerName: string | null;
  /** Who is writing, whose first name opens the reply. */
  readonly viewerName: string;
  /** The brand's name, which opens it too; null until the brand has been read. */
  readonly brandName: string | null;
  /** The thread, for the quote's author and to read the context again when it grows. */
  readonly messages: readonly TicketMessage[];
  /** Who wrote a message, as the thread names them. */
  authorOf(message: TicketMessage): string | null;
}): TicketMeta {
  const t = useT();
  const { locale } = usePreferences();
  const api = useMetaApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const stripId = useId();
  const enabled = META_CHANNELS.has(channel);
  const key = metaKeys.ticket(brandId, ticketId);
  const now = useMinuteClock(enabled);
  const [refusal, setRefusal] = useState<(WindowRefusal & { readAt: number }) | null>(null);

  const read = useQuery({
    queryKey: key,
    queryFn: () => api.ticketContext(brandId, ticketId),
    enabled,
    refetchInterval: (query) => (hasQueued(query.state.data) ? SENDING_POLL_MS : false),
  });
  const refresh = async (): Promise<void> => {
    if (enabled) {
      await queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const retry = useMutation({
    mutationFn: (deliveryId: string) => api.retryDelivery(brandId, ticketId, deliveryId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', message: t('tickets:meta.retried') });
    },
    onError: (error: unknown) => {
      toast({
        tone: 'danger',
        message:
          isMetaError(error) && error.reason === 'reply-window-closed'
            ? t('tickets:meta.retryRefused')
            : t('tickets:meta.retryFailed'),
      });
    },
  });

  const context = read.data?.context ?? undefined;
  const deliveries = read.data?.deliveries ?? [];
  const unsent = new Map((read.data?.unsent ?? []).map((item) => [item.ticketMessageId, item]));
  const marks = new Set((read.data?.unsent ?? []).map((item) => item.lineId));
  const deliveryOf = (message: TicketMessage): MetaDeliveryView | undefined =>
    isReply(message)
      ? deliveries.find((delivery) => delivery.ticketMessageId === message.id)
      : undefined;

  // A new message, ours or the customer's, can move the window and the
  // deliveries: read them again whenever the thread grows.
  const lastSeq = messages.reduce((highest, message) => Math.max(highest, message.seq), 0);
  const seenSeq = useRef<number | null>(null);
  useEffect(() => {
    if (enabled && seenSeq.current !== null && seenSeq.current !== lastSeq) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
    seenSeq.current = lastSeq;
  }, [lastSeq, enabled, queryClient, key]);

  // The refusal holds until the context has been read again, after it, and
  // says the customer wrote: that is the window opening.
  const activeRefusal =
    refusal !== null &&
    !(
      read.dataUpdatedAt > refusal.readAt &&
      context !== undefined &&
      context.window.state !== 'closed'
    )
      ? refusal
      : null;
  const state = context === undefined ? undefined : stripState(context.window, now, activeRefusal);

  // A window that ran out while the ticket was open: ask again, because on
  // Messenger and Instagram the Human Agent days may start where it ended.
  const ranOut = state?.kind === 'closed' && !state.refused && context?.window.state !== 'closed';
  useEffect(() => {
    if (ranOut) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [ranOut, queryClient, key]);

  if (context === undefined || state === undefined) {
    return {
      context: undefined,
      account: undefined,
      thread: undefined,
      strip: null,
      composer: undefined,
      identity: null,
      deliveryFooter: () => null,
      refused: () => false,
      refresh,
    };
  }

  const platform = context.account.platform;
  const platformName = t(`tickets:channel.${platform}`);
  const account = accountLabel(context.account);
  const Icon = PLATFORM_ICONS[platform];
  const recipient =
    customerName === null || customerName.trim() === ''
      ? t(platform === 'messenger' ? 'tickets:meta.messengerUser' : 'tickets:meta.theCustomer')
      : customerName;

  const lead = (text: string): ReactNode => (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, verticalAlign: 'middle' }}
    >
      <Icon size={14} aria-hidden="true" />
      {text}
    </Box>
  );

  const thread: ThreadMeta = {
    pinKey: state.kind === 'closed' && state.refused ? 'refused' : 'strip',
    leadFor: (message) =>
      message.authorType === 'contact'
        ? lead(t('tickets:meta.via', { account }))
        : isReply(message)
          ? lead(t('tickets:meta.to', { channel: platformName }))
          : null,
    trailFor: (message) => {
      const delivery = deliveryOf(message);
      return delivery === undefined ? null : <DeliveryTrail delivery={delivery} />;
    },
    labelFor: (message, author) => {
      const delivery = deliveryOf(message);
      return delivery === undefined
        ? undefined
        : t('tickets:meta.replyLabel', {
            name: author,
            state: t(`tickets:meta.state.${delivery.status}`),
          });
    },
    contentFor: (message) => {
      if (message.authorType !== 'contact' || message.kind !== 'public') {
        return undefined;
      }
      const story = splitStory(message);
      const quote = splitQuote(story?.html ?? message.bodyHtml);
      const unsentMark = unsent.get(message.id);
      if (story === undefined && quote === undefined && unsentMark === undefined) {
        return undefined;
      }
      const earlier = messages.filter((candidate) => candidate.seq < message.seq);
      const quoted = quote === undefined ? undefined : quotedMessage(quote.quoteText, earlier);
      const date = new Intl.DateTimeFormat(numbering(locale), {
        day: 'numeric',
        month: 'short',
      }).format(new Date(message.createdAt));

      return {
        html: quote?.html ?? story?.html ?? message.bodyHtml,
        before: (
          <>
            {story === undefined ? null : (
              <>
                <StoryCaption label={story.label} />
                <Box sx={{ marginBlockEnd: 2 }}>
                  <StoryFigure date={date} />
                </Box>
              </>
            )}
            {quote === undefined ? null : (
              <QuoteLine
                author={quoted === undefined ? null : authorOf(quoted)}
                text={quote.quoteText}
              />
            )}
          </>
        ),
        ...(unsentMark === undefined
          ? {}
          : { after: <UnsentCaption time={clockTime(unsentMark.at, locale)} /> }),
      };
    },
    hides: (message) => message.kind === 'system' && marks.has(message.id),
    lineIcon: (message) => {
      if (message.kind !== 'system') {
        return undefined;
      }
      const kind = classifyMetaLine(message.bodyText);
      return kind === null || kind === 'numberChanged' ? undefined : LINE_ICONS[kind];
    },
    attachmentFor: (attachment, message) => {
      if (isSticker(attachment)) {
        return <StickerFigure key={attachment.id} />;
      }
      // The story's media is the figure above the text, not a chip under it.
      return isStoryMedia(attachment) && splitStory(message) !== undefined ? null : undefined;
    },
  };

  const handle = customerHandle(context);

  return {
    context,
    account,
    thread,
    strip: (
      <Box sx={{ paddingInline: 5, paddingBlockEnd: 2 }}>
        <ReplyWindowStrip
          id={stripId}
          state={state}
          platform={platform}
          customerName={recipient}
          now={now}
        />
      </Box>
    ),
    composer: {
      platform,
      customerName: recipient,
      handle,
      account,
      openingLine:
        brandName === null
          ? ''
          : metaOpeningLine({ firstName: firstWordOf(viewerName), brand: brandName }),
      closed: state.kind === 'closed',
      stripId,
    },
    identity: <ChannelIdentityRows context={context} />,
    deliveryFooter: (message) => {
      const delivery = deliveryOf(message);
      if (
        delivery === undefined ||
        (delivery.status !== 'failed' &&
          delivery.status !== 'refused' &&
          delivery.leftOut.length === 0)
      ) {
        return null;
      }

      return (
        <DeliveryNotice
          delivery={delivery}
          platform={platform}
          attachments={message.attachments}
          busy={retry.isPending}
          onRetry={() => {
            retry.mutate(delivery.id);
          }}
        />
      );
    },
    refused: (error) => {
      if (!isMetaError(error) || error.reason !== 'reply-window-closed') {
        return false;
      }
      setRefusal({ closedAt: error.details?.closedAt ?? null, readAt: read.dataUpdatedAt });
      void queryClient.invalidateQueries({ queryKey: key });

      return true;
    },
    refresh,
  };
}

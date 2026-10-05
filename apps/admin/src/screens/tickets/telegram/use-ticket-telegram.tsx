import type { Attachment, TelegramTicketContext, TicketMessage } from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { telegramKeys } from '../../../telegram/api.js';
import { useTelegramApi } from '../../../telegram/context.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { DeliveryState, TelegramDeliveryFailure } from './delivery-state.tsx';
import { VoiceNote } from './voice-note.tsx';

/**
 * What the ticket view needs for its Telegram half (M6-02, M6-03,
 * `Admin/Ticket-Telegram`), in one hook so the view only passes it along: the
 * chat the ticket is with, the thread's "via @bot" and "to the Telegram chat ·
 * Sent" lines, "Not delivered · Retry" under a refused reply, and the voice
 * note player. Undefined `context` means the ticket is not a Telegram one, or
 * no chat belongs to it, and the view draws nothing Telegram.
 */

export interface ThreadTelegram {
  /** Before a message's time: "via @bot" or "to the Telegram chat". */
  leadFor(message: TicketMessage): string | null;
  /** After a reply's time: whether Telegram has it. */
  trailFor(message: TicketMessage): ReactNode;
  /** A voice note's player in place of its chip; undefined for any other file. */
  attachmentFor(attachment: Attachment, time: string): ReactNode | undefined;
}

export interface TicketTelegram {
  readonly context: TelegramTicketContext | undefined;
  readonly thread: ThreadTelegram | undefined;
  deliveryFooter(message: TicketMessage): ReactNode;
  /** After a send, so the new reply's delivery shows. */
  refresh(): Promise<void>;
}

const isReply = (message: TicketMessage): boolean =>
  message.kind === 'public' && message.authorType === 'staff';

export function useTicketTelegram(
  brandId: string,
  ticketId: string,
  channel: string,
): TicketTelegram {
  const t = useT();
  const api = useTelegramApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const enabled = channel === 'telegram';
  const key = telegramKeys.ticket(brandId, ticketId);

  const read = useQuery({
    queryKey: key,
    queryFn: () => api.ticketContext(brandId, ticketId),
    enabled,
  });
  const retry = useMutation({
    mutationFn: (deliveryId: string) => api.retryDelivery(brandId, ticketId, deliveryId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', message: t('tickets:telegram.retried') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('tickets:telegram.retryFailed') });
    },
  });

  const context = read.data?.context ?? undefined;
  const deliveries = read.data?.deliveries ?? [];
  const deliveryOf = (message: TicketMessage) =>
    deliveries.find((delivery) => delivery.messageId === message.id);

  const thread: ThreadTelegram | undefined =
    context === undefined
      ? undefined
      : {
          leadFor: (message) =>
            message.authorType === 'contact'
              ? t('tickets:telegram.via', { bot: context.bot.username })
              : isReply(message)
                ? t('tickets:telegram.toChat')
                : null,
          trailFor: (message) => {
            const delivery = isReply(message) ? deliveryOf(message) : undefined;
            return delivery === undefined ? null : <DeliveryState delivery={delivery} />;
          },
          attachmentFor: (attachment, time) =>
            attachment.kind === 'audio' && attachment.status === 'ready' ? (
              <VoiceNote
                key={attachment.id}
                brandId={brandId}
                attachment={attachment}
                time={time}
              />
            ) : undefined,
        };

  return {
    context,
    thread,
    deliveryFooter: (message) => {
      const delivery = isReply(message) ? deliveryOf(message) : undefined;
      return delivery?.status === 'failed' ? (
        <TelegramDeliveryFailure
          delivery={delivery}
          busy={retry.isPending}
          onRetry={() => {
            retry.mutate(delivery.id);
          }}
        />
      ) : null;
    },
    refresh: async () => {
      if (enabled) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
  };
}

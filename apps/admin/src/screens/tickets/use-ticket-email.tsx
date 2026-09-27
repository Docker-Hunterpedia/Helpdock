import { type EmailSender, repliesByEmail, type TicketMessage } from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useEmailApi, useTicketsApi } from '../../auth/session.tsx';
import { emailKeys } from '../../email/api.js';
import { useToast } from '../../ui/toasts.tsx';
import { formatSender } from '../admin/channels/sender-format.js';
import { type ComposerEmail, DeliveryFailure } from './email-compose.tsx';

/**
 * What the ticket view needs for its email half (M2-05), in one hook so the
 * view only passes it along: the composer's email mode for a ticket that
 * answers by email, the sender a reply goes out as, and the "Not delivered ·
 * Retry" footer for the thread.
 *
 * The Cc line is the ticket's CC participants (DOMAIN-RULES §2.5), under the
 * same query key as the Participants card, so adding one in either place shows
 * in both.
 */

export interface TicketEmail {
  /** Undefined for a ticket that answers on another channel. */
  readonly composer: ComposerEmail | undefined;
  /** The sender to send the next reply as, for the message request. */
  readonly emailFrom: string | undefined;
  /** What the thread draws under a message; null for most. */
  deliveryFooter(message: TicketMessage): ReactNode;
  /** After a send, so the new reply's delivery shows. */
  refresh(): Promise<void>;
}

const senderLabel = (from: EmailSender): string => formatSender(from);

export function useTicketEmail(brandId: string, ticketId: string, channel: string): TicketEmail {
  const t = useT();
  const api = useEmailApi();
  const tickets = useTicketsApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const enabled = repliesByEmail(channel);
  const contextKey = emailKeys.ticket(brandId, ticketId);
  const participantsKey = ['ticket-participants', brandId, ticketId];

  const context = useQuery({
    queryKey: contextKey,
    queryFn: () => api.ticketEmail(brandId, ticketId),
    enabled,
  });
  const participants = useQuery({
    queryKey: participantsKey,
    queryFn: () => tickets.participants(brandId, ticketId),
    enabled,
  });

  const [fromKey, setFromKey] = useState<string | null>(null);
  const selected = context.data?.selectedKey ?? null;
  // A ticket opened, or moved to another department, starts on its own sender.
  useEffect(() => {
    setFromKey(selected);
  }, [selected]);

  const failed = (): void => {
    toast({ tone: 'danger', message: t('tickets:participants.failed') });
  };

  const addCc = useMutation({
    mutationFn: (email: string) => tickets.addCc(brandId, ticketId, { email }),
    onSuccess: (list, email) => {
      queryClient.setQueryData(participantsKey, list);
      toast({ tone: 'success', message: t('tickets:participants.added', { address: email }) });
    },
    onError: failed,
  });
  const removeCc = useMutation({
    mutationFn: ({ id }: { id: string; address: string }) =>
      tickets.removeCc(brandId, ticketId, id),
    onSuccess: (list, { address }) => {
      queryClient.setQueryData(participantsKey, list);
      toast({ tone: 'success', message: t('tickets:participants.removed', { address }) });
    },
    onError: failed,
  });
  const retry = useMutation({
    mutationFn: (messageId: string) => api.retryMessage(brandId, ticketId, messageId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contextKey });
      toast({ tone: 'success', message: t('tickets:email.retried') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('tickets:email.retryFailed') });
    },
  });

  const data = context.data;
  const composer: ComposerEmail | undefined =
    !enabled || data === undefined
      ? undefined
      : {
          senders: data.senders.map((sender) => ({
            key: sender.key,
            label: senderLabel(sender.from),
          })),
          fromKey,
          onFromChange: setFromKey,
          to: data.to,
          ccs: (participants.data?.ccs ?? []).flatMap((cc) =>
            cc.address === null ? [] : [{ id: cc.id, address: cc.address }],
          ),
          busy: addCc.isPending || removeCc.isPending,
          onAddCc: (address) => {
            addCc.mutate(address);
          },
          onRemoveCc: (id, address) => {
            removeCc.mutate({ id, address });
          },
          signature: data.signature,
        };

  return {
    composer,
    emailFrom: composer === undefined || fromKey === null ? undefined : fromKey,
    deliveryFooter: (message) => {
      const delivery = data?.deliveries.find((candidate) => candidate.messageId === message.id);
      return delivery === undefined ? null : (
        <DeliveryFailure
          delivery={delivery}
          busy={retry.isPending}
          onRetry={() => {
            retry.mutate(message.id);
          }}
        />
      );
    },
    refresh: async () => {
      if (enabled) {
        await queryClient.invalidateQueries({ queryKey: contextKey });
      }
    },
  };
}

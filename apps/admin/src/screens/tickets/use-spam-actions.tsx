import type { Ticket } from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useTicketsApi } from '../../auth/session.tsx';
import { isTicketingError } from '../../ticketing/api.js';
import { refusalCopy } from '../../ticketing/refusal-copy.js';
import { ticketKeys } from '../../tickets/keys.js';
import { useToast } from '../../ui/toasts.tsx';
import { MarkSpamDialog } from './mark-spam-dialog.tsx';
import type { TicketMenuItem } from './ticket-actions-menu.tsx';

/**
 * M1-11's share of the ticket workspace: the menu item and the dialog behind
 * it, as one hook so the workspace adds two lines rather than a state machine.
 *
 * | The ticket is | The menu offers |
 * |---|---|
 * | not spam | "Mark as spam", last and in danger, opening the dialog |
 * | spam | "Not spam", which reopens it at once — nothing is lost by it |
 * | merged into another | nothing: its state is the primary's (DOMAIN-RULES §2.4) |
 */
export function useSpamActions(
  brandId: string,
  ticket: Ticket | undefined,
): { readonly items: readonly TicketMenuItem[]; readonly dialog: ReactNode } {
  const t = useT();
  const api = useTicketsApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ticketId = ticket?.id ?? '';

  const sender = useQuery({
    queryKey: ['spam-sender', brandId, ticketId],
    queryFn: () => api.spamSender(brandId, ticketId),
    enabled: open && ticket !== undefined,
    staleTime: 0,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) });
    await queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) });
  };

  const failed = (error: unknown): void => {
    toast({
      tone: 'danger',
      message: isTicketingError(error) ? t(refusalCopy(error.reason)) : t('tickets:toast.failed'),
    });
  };

  const mark = useMutation({
    mutationFn: (blockSender: boolean) => api.markSpam(brandId, ticketId, { blockSender }),
    onSuccess: async (_ticket, blockSender) => {
      setOpen(false);
      await refresh();
      const blocked = sender.data?.sender?.value;
      toast({
        tone: 'success',
        message:
          blockSender && blocked !== undefined
            ? t('tickets:toast.markedSpamBlocked', { sender: blocked })
            : t('tickets:toast.markedSpam'),
      });
    },
    onError: failed,
  });

  const unmark = useMutation({
    mutationFn: () => api.unmarkSpam(brandId, ticketId),
    onSuccess: async () => {
      await refresh();
      toast({ tone: 'success', message: t('tickets:toast.notSpam') });
    },
    onError: failed,
  });

  if (ticket === undefined || ticket.mergedIntoId !== null) {
    return { items: [], dialog: null };
  }

  const items: TicketMenuItem[] = ticket.status.isSpam
    ? [
        {
          key: 'not-spam',
          label: t('tickets:actions.notSpam'),
          icon: ShieldCheck,
          separatorBefore: true,
          onSelect: () => {
            unmark.mutate();
          },
        },
      ]
    : [
        {
          key: 'mark-spam',
          label: t('tickets:actions.markSpam'),
          icon: ShieldAlert,
          tone: 'danger',
          separatorBefore: true,
          onSelect: () => {
            setOpen(true);
          },
        },
      ];

  return {
    items,
    dialog: (
      <MarkSpamDialog
        open={open}
        ticket={ticket}
        sender={sender.data}
        busy={mark.isPending}
        onConfirm={(blockSender) => {
          mark.mutate(blockSender);
        }}
        onClose={() => {
          setOpen(false);
        }}
      />
    ),
  };
}

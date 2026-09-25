import type { TimeEntryCreateRequest, TimeEntryList } from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '../../app/i18n.js';
import { useTicketsApi } from '../../auth/session.tsx';
import { isTicketingError } from '../../ticketing/api.js';
import { ticketKeys } from '../../tickets/keys.js';
import { useToast } from '../../ui/toasts.tsx';

/**
 * The Time card's data (M1-12): the ticket's entries, and the two writes. Each
 * write answers with the whole list, which goes straight into the cache, so
 * the card redraws from the server's sum rather than from one it computed.
 *
 * Read only while the brand has time tracking on: the card is not drawn
 * otherwise, and a query for a card nobody sees is a request for nothing.
 */
export function useTimeEntries(brandId: string, ticketId: string, enabled: boolean) {
  const t = useT();
  const api = useTicketsApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = ticketKeys.time(brandId, ticketId);

  const entries = useQuery({
    queryKey: key,
    queryFn: () => api.timeEntries(brandId, ticketId),
    enabled,
  });

  const settle = (list: TimeEntryList): void => {
    queryClient.setQueryData(key, list);
  };

  const failed = (error: unknown): void => {
    toast({
      tone: 'danger',
      message: t(
        isTicketingError(error) && error.reason === 'time-tracking-off'
          ? 'tickets:toast.timeTrackingOff'
          : 'tickets:toast.timeFailed',
      ),
    });
  };

  const log = useMutation({
    mutationFn: (request: TimeEntryCreateRequest) => api.logTime(brandId, ticketId, request),
    onSuccess: (list) => {
      settle(list);
      toast({ tone: 'success', message: t('tickets:toast.timeLogged') });
    },
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: (entryId: string) => api.deleteTimeEntry(brandId, ticketId, entryId),
    onSuccess: (list) => {
      settle(list);
      toast({ tone: 'success', message: t('tickets:toast.timeDeleted') });
    },
    onError: failed,
  });

  /** After a reply that carried the timer, whose entry the api wrote with it. */
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });

  return { entries, log, remove, refresh };
}

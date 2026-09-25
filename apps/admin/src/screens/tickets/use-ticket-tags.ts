import type { TagSummary, TicketDetail } from '@helpdock/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useT } from '../../app/i18n.js';
import { useTicketsApi } from '../../auth/session.tsx';
import { ticketKeys } from '../../tickets/keys.js';
import { tagsForIds, withTicketTags } from '../../tickets/tags.js';
import { useToast } from '../../ui/toasts.tsx';

/**
 * Saving a ticket's tags (M1-15), optimistically.
 *
 * The chips move the moment somebody picks, because the answer to a tag is
 * almost always yes and a row that waits a round trip per click feels broken.
 * The read the chips were drawn from is kept, and a refusal puts it back and
 * says so in a toast — the set on screen is never one the api did not accept.
 * Either way the ticket is read again afterwards, for its activity line and for
 * whatever a refusal was about (a tag deleted since the read, most often).
 */
export function useTicketTags(brandId: string, ticketId: string, brandTags: readonly TagSummary[]) {
  const t = useT();
  const api = useTicketsApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = ticketKeys.detail(brandId, ticketId);

  return useMutation({
    mutationFn: (tagIds: string[]) => api.setTags(brandId, ticketId, tagIds),
    onMutate: async (tagIds) => {
      // A read landing mid-save would draw the old set over the new one.
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TicketDetail>(key);
      if (previous !== undefined) {
        queryClient.setQueryData<TicketDetail>(
          key,
          withTicketTags(previous, tagsForIds(tagIds, previous.ticket.tags ?? [], brandTags)),
        );
      }

      return { previous };
    },
    onSuccess: ({ tags }) => {
      queryClient.setQueryData<TicketDetail>(key, (held) =>
        held === undefined ? held : withTicketTags(held, tags),
      );
    },
    onError: (_error, _tagIds, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(key, context.previous);
      }
      toast({ tone: 'danger', message: t('tickets:toast.tagsFailed') });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) }),
      ]);
    },
  });
}

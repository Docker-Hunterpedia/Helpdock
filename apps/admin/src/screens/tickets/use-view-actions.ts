import type { TicketView, TicketViewCreateInput, TicketViewUpdateInput } from '@helpdock/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useT } from '../../app/i18n.js';
import { currentBrand, useSession, useTicketsApi } from '../../auth/session.tsx';
import { isTicketingError } from '../../ticketing/api.js';
import { refusalCopy } from '../../ticketing/refusal-copy.js';
import { ticketKeys } from '../../tickets/keys.js';
import { useToast } from '../../ui/toasts.tsx';

/**
 * Every change to a view, wired once (M1-05): the sidebar's menu, the list
 * header's bar and the Views tab all save, rename, share, hide, reorder and
 * delete through these, so each refreshes the same two reads — the views and
 * their counts — and answers a refusal with the same translated sentence.
 */
export function useViewActions() {
  const t = useT();
  const api = useTicketsApi();
  const session = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const brandId = currentBrand(session).id;

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ticketKeys.views(brandId) }),
      queryClient.invalidateQueries({ queryKey: ticketKeys.counts(brandId) }),
    ]);
  };

  const report = (error: unknown): void => {
    toast({
      tone: 'danger',
      message: isTicketingError(error) ? t(refusalCopy(error.reason)) : t('tickets:toast.failed'),
    });
  };

  const create = useMutation({
    mutationFn: (request: TicketViewCreateInput) => api.createView(brandId, request),
    onSuccess: async (view: TicketView) => {
      await refresh();
      toast({ tone: 'success', message: t('tickets:viewToast.saved', { name: view.name }) });
    },
    onError: report,
  });

  const update = useMutation({
    mutationFn: ({ view, request }: { view: TicketView; request: TicketViewUpdateInput }) =>
      api.updateView(brandId, view.id, request),
    onSuccess: async (view: TicketView) => {
      await refresh();
      toast({ tone: 'success', message: t('tickets:viewToast.updated', { name: view.name }) });
    },
    onError: report,
  });

  const remove = useMutation({
    mutationFn: (view: TicketView) => api.deleteView(brandId, view.id),
    onSuccess: async (_result, view: TicketView) => {
      await refresh();
      toast({ tone: 'success', message: t('tickets:viewToast.deleted', { name: view.name }) });
    },
    onError: report,
  });

  const reorder = useMutation({
    mutationFn: (viewIds: readonly string[]) => api.reorderViews(brandId, viewIds),
    onSuccess: async () => {
      await refresh();
      toast({ tone: 'success', message: t('tickets:viewToast.reordered') });
    },
    onError: report,
  });

  return {
    create,
    update,
    remove,
    reorder,
    busy: [create, update, remove, reorder].some((mutation) => mutation.isPending),
  };
}

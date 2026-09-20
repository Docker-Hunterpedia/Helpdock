import { useMutation } from '@tanstack/react-query';
import { useT } from '../../../app/i18n.js';
import { isAuthError } from '../../../auth/api.js';
import { isTicketingError } from '../../../ticketing/api.js';
import { refusalCopy } from '../../../ticketing/refusal-copy.js';
import { useToast } from '../../../ui/toasts.tsx';

/**
 * What every tab of `Admin/Ticketing` does with a mutation, in one place: send
 * it, invalidate what the server just changed, say so in a toast, and turn a
 * refusal into the sentence its code names.
 *
 * It started as a private helper on the Departments tab. M1-06 added three more
 * tabs that answer failures identically, and four copies of the same wiring
 * would be four places for it to drift. Which sentence a refusal becomes is
 * `ticketing/refusal-copy.ts`, shared with the tabs that do not use this hook.
 */

/**
 * Turns whatever came back into a toast. A refusal is about the action and the
 * page behind it is still correct, so it is a toast and never a banner.
 */
export function useTicketingReport(): (error: unknown) => void {
  const t = useT();
  const toast = useToast();

  return (error: unknown): void => {
    if (isTicketingError(error)) {
      toast({ tone: 'danger', message: t(refusalCopy(error.reason)) });
      return;
    }

    toast({
      tone: 'danger',
      message: isAuthError(error) ? t('auth:unavailable') : t('ticketing:toast.failed'),
    });
  };
}

/** One mutation, wired the same way every time. */
export function useTicketingAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  message: (input: TInput) => string,
  refresh: () => Promise<void>,
  report: (error: unknown) => void,
) {
  const toast = useToast();

  return useMutation({
    mutationFn: run,
    onSuccess: async (_result: TResult, input: TInput) => {
      await refresh();
      toast({ tone: 'success', message: message(input) });
    },
    onError: report,
  });
}

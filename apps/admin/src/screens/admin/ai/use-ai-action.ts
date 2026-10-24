import { useMutation } from '@tanstack/react-query';
import { useT } from '../../../app/i18n.js';
import { useToast } from '../../../ui/toasts.tsx';
import { failureMessage } from './format.js';

/**
 * One save, wired the same way on every AI card: run it, refresh what it
 * changed, and say so — or say why the api refused it.
 */
export function useAiAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  success: string,
  refresh: (result: TResult) => Promise<void> | void,
  /** Answers a refusal the card draws on a field; true means it did, so no toast. */
  refused?: (error: unknown) => boolean,
) {
  const t = useT();
  const toast = useToast();

  return useMutation({
    mutationFn: run,
    onSuccess: async (result: TResult) => {
      await refresh(result);
      toast({ tone: 'success', message: success });
    },
    onError: (error: unknown) => {
      if (refused?.(error) === true) {
        return;
      }
      toast({ tone: 'danger', message: failureMessage(t, error) });
    },
  });
}

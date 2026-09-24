import type { ContactRefusal } from '@helpdock/schemas';
import { useMutation } from '@tanstack/react-query';
import { useT } from '../../app/i18n.js';
import { isAuthError } from '../../auth/api.js';
import { isContactError } from '../../contacts/api.js';
import { useToast } from '../../ui/toasts.tsx';

/**
 * One contact action: run it, say what happened, and turn a refusal into the
 * sentence the catalog holds for it.
 *
 * Every mutation on both contact screens has that shape, so it lives here and
 * each call site is three lines — the same arrangement `staff.tsx` uses and for
 * the same reason.
 *
 * A refusal is a toast rather than a banner: the four rules that answer no are
 * about the action, not about the page, and the page behind the toast is still
 * correct.
 */

const TOAST_KEY: Readonly<Record<ContactRefusal, string>> = {
  'identity-taken': 'contacts:toast.identityTaken',
  'identity-invalid': 'contacts:toast.failed',
  'last-identity': 'contacts:toast.lastIdentity',
  'anonymise-forbidden': 'contacts:toast.anonymiseForbidden',
  anonymised: 'contacts:toast.alreadyAnonymised',
  'domain-taken': 'contacts:toast.domainTaken',
  merged: 'contacts:toast.merged',
  'merge-self': 'contacts:toast.mergeSelf',
  'merge-expired': 'contacts:toast.mergeExpired',
  'merge-blocked': 'contacts:toast.mergeBlocked',
};

/** The sentence for a failure, whatever kind it is. */
export function useContactErrorMessage(): (error: unknown) => string {
  const t = useT();

  return (error: unknown): string => {
    if (isContactError(error)) {
      // An invalid identifier says *how* it was invalid, because the person can
      // fix that; every other refusal is about a rule, not about a keystroke.
      if (error.reason === 'identity-invalid' && error.problem !== undefined) {
        return t(`contacts:problem.${error.problem}`);
      }

      return t(TOAST_KEY[error.reason] as 'contacts:toast.failed');
    }

    return t(isAuthError(error) ? 'auth:unavailable' : 'contacts:toast.failed');
  };
}

export function useContactAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  message: (input: TInput, result: TResult) => string,
  after?: (result: TResult, input: TInput) => void | Promise<void>,
) {
  const toast = useToast();
  const describe = useContactErrorMessage();

  return useMutation({
    mutationFn: run,
    onSuccess: async (result: TResult, input: TInput) => {
      await after?.(result, input);
      toast({ tone: 'success', message: message(input, result) });
    },
    onError: (error: unknown) => {
      toast({ tone: 'danger', message: describe(error) });
    },
  });
}

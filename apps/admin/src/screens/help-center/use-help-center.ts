import type { HcLocale, HcStructure } from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { isAuthError } from '../../auth/api.js';
import { currentBrand, useSession } from '../../auth/session.tsx';
import { helpCenterKeys, isHelpCenterError } from '../../help-center/api.js';
import { useHelpCenterApi } from '../../help-center/context.tsx';
import { useToast } from '../../ui/toasts.tsx';

/** The brand, the adapter and the structure query every help center screen starts from. */
export function useHelpCenter() {
  const brand = currentBrand(useSession());
  const api = useHelpCenterApi();
  const structure = useQuery({
    queryKey: helpCenterKeys.structure(brand.id),
    queryFn: () => api.structure(brand.id),
  });
  return { brand, api, structure };
}

/** The reader's own language, which names and titles are shown in. */
export function useReaderLocale(): HcLocale {
  return usePreferences().locale;
}

/**
 * The section the tree has selected, kept in the url (`?section=`) so the page
 * header's "New article" and the list agree on it, and a reload keeps it.
 */
export function useSelectedSection(): [string | null, (sectionId: string | null) => void] {
  const [search, setSearch] = useSearchParams();
  const selected = search.get('section');
  return [
    selected,
    (sectionId) => {
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          if (sectionId === null) {
            next.delete('section');
          } else {
            next.set('section', sectionId);
          }
          return next;
        },
        { replace: true },
      );
    },
  ];
}

/** Turns a failed change into the one sentence its refusal names. */
export function useHelpCenterReport(): (error: unknown) => void {
  const t = useT();
  const toast = useToast();
  return (error) => {
    toast({
      tone: 'danger',
      message: isHelpCenterError(error)
        ? t(`helpCenter:refusals.${error.reason}`)
        : isAuthError(error)
          ? t('auth:unavailable')
          : t('helpCenter:toast.failed'),
    });
  };
}

/**
 * One change to the structure: send it, refresh what it touched, say so. The
 * structure answer of a reorder is written straight into the cache, so a drag
 * does not flicker back while the refetch is in flight.
 */
export function useStructureChange<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  message: ((input: TInput) => string) | null,
) {
  const brand = currentBrand(useSession());
  const queryClient = useQueryClient();
  const toast = useToast();
  const report = useHelpCenterReport();
  return useMutation({
    mutationFn: run,
    onSuccess: async (result, input) => {
      if (isStructure(result)) {
        queryClient.setQueryData(helpCenterKeys.structure(brand.id), result);
      }
      await queryClient.invalidateQueries({ queryKey: helpCenterKeys.all(brand.id) });
      if (message !== null) {
        toast({ tone: 'success', message: message(input) });
      }
    },
    onError: report,
  });
}

const isStructure = (value: unknown): value is HcStructure =>
  typeof value === 'object' && value !== null && 'categories' in value && 'articles' in value;

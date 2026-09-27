import type { HcSite } from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '../../../app/i18n.js';
import { helpCenterKeys } from '../../../help-center/api.js';
import { useToast } from '../../../ui/toasts.tsx';
import { useHelpCenter, useHelpCenterReport } from '../use-help-center.js';

/** The Settings tab's site query (M5-06): theme, home page, links, custom CSS. */
export function useSite() {
  const { brand, api } = useHelpCenter();
  return useQuery({ queryKey: helpCenterKeys.site(brand.id), queryFn: () => api.site(brand.id) });
}

/**
 * One card's save: send it, write what came back into the site query, say
 * so; or say the one sentence the refusal names.
 */
export function useSiteSave<TInput, TResult>(
  run: (brandId: string, input: TInput) => Promise<TResult>,
  merge: (site: HcSite, result: TResult) => HcSite,
  onSaved?: (result: TResult) => void,
) {
  const t = useT();
  const toast = useToast();
  const report = useHelpCenterReport();
  const queryClient = useQueryClient();
  const { brand } = useHelpCenter();
  return useMutation({
    mutationFn: (input: TInput) => run(brand.id, input),
    onSuccess: (result) => {
      queryClient.setQueryData<HcSite>(helpCenterKeys.site(brand.id), (site) =>
        site === undefined ? site : merge(site, result),
      );
      onSaved?.(result);
      toast({ tone: 'success', message: t('helpCenter:site.saved') });
    },
    onError: report,
  });
}

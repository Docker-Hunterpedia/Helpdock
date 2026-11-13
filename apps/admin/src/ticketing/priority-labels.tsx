import { NAMESPACES } from '@helpdock/i18n';
import type { PriorityLabelLocale, PriorityLabelsInput, TicketPriority } from '@helpdock/schemas';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { currentBrand, useOptionalTicketingApi, useSession } from '../auth/session.tsx';

/**
 * What the brand calls its four priorities (M1-02), for every staff screen.
 *
 * The names are the brand's `settings.priorityLabels`, read through the same
 * `['brand', id]` query the settings pages use, so a save that invalidates it
 * redraws every open screen without a reload. They live in a context rather
 * than a query in each caller so that a component drawn without a session (a
 * preview, a unit test) still has an answer: the catalog default.
 *
 * Display only. The value on the wire, in rules, SLAs, imports and webhooks
 * stays `low | medium | high | urgent`.
 */
const PriorityLabelsContext = createContext<PriorityLabelsInput>({});

export function PriorityLabelsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const session = useSession();
  const api = useOptionalTicketingApi();
  const brandId = currentBrand(session).id;

  const brand = useQuery({
    queryKey: ['brand', brandId],
    queryFn: () => {
      if (api === null) {
        throw new Error('no ticketing api');
      }
      return api.brand(brandId);
    },
    enabled: api !== null,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <PriorityLabelsContext.Provider value={brand.data?.settings.priorityLabels ?? {}}>
      {children}
    </PriorityLabelsContext.Provider>
  );
}

const interfaceLocale = (language: string | undefined): PriorityLabelLocale =>
  language?.startsWith('ar') === true ? 'ar' : 'en';

/**
 * The name of a priority in the interface language: the brand's name for it, or
 * the catalog default when it has none.
 */
export function usePriorityLabel(): (priority: TicketPriority) => string {
  const labels = useContext(PriorityLabelsContext);
  const { t, i18n } = useTranslation(NAMESPACES);
  const locale = interfaceLocale(i18n.language);

  return useCallback(
    (priority: TicketPriority): string => {
      const override = labels[priority]?.[locale];

      return override ?? t(`tickets:priority.${priority}`);
    },
    [labels, locale, t],
  );
}

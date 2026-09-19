import { Construction } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { EmptyState } from '../../../shell/empty-state.tsx';
import type { TicketingTab } from './tabs.js';

/**
 * A tab whose deliverable has not landed. It names the deliverable rather than
 * saying "coming soon", because the person reading it is an operator deciding
 * whether to wait or to work around it, and a milestone id is something they
 * can look up.
 */
export function NotBuiltYetTab({ tab }: { readonly tab: TicketingTab }): ReactNode {
  const t = useT();

  return (
    <EmptyState
      icon={Construction}
      heading={t('ticketing:soon.heading')}
      body={t('ticketing:soon.body', {
        tab: t(`ticketing:tabs.${tab.key}`),
        milestone: tab.milestone,
      })}
    />
  );
}

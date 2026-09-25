import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { ActionsMenu, type MenuAction } from '../../ui/actions-menu.tsx';

/**
 * The ⋯ menu beside the ticket header's buttons — panel 2 of
 * `AdminTicketDialogs`. M1-09 passes Merge and Split, M1-12 adds Log time when
 * time tracking is on, M1-11 adds Mark as spam last, in danger, after a
 * divider.
 */

export type TicketAction = MenuAction;

export function TicketActionsMenu({
  items,
}: {
  readonly items: readonly TicketAction[];
}): ReactNode {
  const t = useT();

  return (
    <ActionsMenu
      items={items}
      label={t('tickets:header.more')}
      menuLabel={t('tickets:actions.label')}
    />
  );
}

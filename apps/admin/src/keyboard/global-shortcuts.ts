import type { TicketViewBuiltIn } from '@helpdock/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { ROUTES } from '../app/route-paths.js';
import { currentBrand, useSession, useTicketsApi } from '../auth/session.tsx';
import { usePalette } from '../palette/palette-provider.tsx';
import { ADMIN_NAV, navFor } from '../shell/nav-items.js';
import { ticketKeys } from '../tickets/keys.js';
import { ALL_VIEW, viewSearch, type WorkspaceIntent, withIntent } from '../tickets/views.js';
import { useKeyboard, useShortcutHandlers } from './keyboard-provider.tsx';
import type { ShortcutId } from './registry.js';

/** The global shortcuts the shell answers (the sidebar's `b` is the shell's own). */
export const GLOBAL_SHORTCUTS = [
  'general.search',
  'general.newTicket',
  'general.shortcuts',
  'general.palette',
  'goTo.myOpen',
  'goTo.unassigned',
  'goTo.overdue',
  'goTo.contacts',
  'goTo.helpCenter',
  'goTo.reports',
  'goTo.settings',
] as const satisfies readonly ShortcutId[];

const TICKETS_PREFIX = `${ROUTES.tickets}/`;

/**
 * What the global shortcuts do, from any page of the signed-in admin.
 *
 * `/` and `c` act on the ticket workspace: from another page they open it
 * first. They travel as an intent in the URL (`?intent=search`), which the
 * workspace acts on once and drops, as it does the sidebar's; on the
 * workspace itself the open ticket and the view are kept.
 *
 * `g` then `i`, `u` or `o` opens a built-in view by what it is, not by its
 * id, which is the brand's own; `g` then `s` opens the first page of the
 * sidebar's Admin group the person is offered.
 */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const session = useSession();
  const api = useTicketsApi();
  const queryClient = useQueryClient();
  const { openSheet } = useKeyboard();
  const palette = usePalette();
  const brandId = currentBrand(session).id;

  const toWorkspace = (intent: WorkspaceIntent): void => {
    const onWorkspace = pathname === ROUTES.tickets || pathname.startsWith(TICKETS_PREFIX);
    void navigate(
      onWorkspace
        ? { pathname, search: withIntent(search, intent) }
        : { pathname: ROUTES.tickets, search: withIntent('', intent) },
    );
  };

  const toView = (builtIn: TicketViewBuiltIn): void => {
    void queryClient
      .fetchQuery({ queryKey: ticketKeys.views(brandId), queryFn: () => api.views(brandId) })
      .then(
        ({ views }) => views.find((view) => view.builtIn === builtIn)?.id ?? ALL_VIEW,
        () => ALL_VIEW,
      )
      .then((viewId) => navigate(`${ROUTES.tickets}${viewSearch(viewId)}`));
  };

  const go = (path: string) => () => {
    void navigate(path);
  };

  useShortcutHandlers<(typeof GLOBAL_SHORTCUTS)[number]>({
    'general.search': () => {
      toWorkspace('search');
    },
    'general.newTicket': () => {
      toWorkspace('new');
    },
    'general.shortcuts': openSheet,
    'general.palette': palette.open,
    'goTo.myOpen': () => {
      toView('my_open');
    },
    'goTo.unassigned': () => {
      toView('unassigned');
    },
    'goTo.overdue': () => {
      toView('overdue');
    },
    'goTo.contacts': go(ROUTES.contacts),
    'goTo.helpCenter': go(ROUTES.helpCenter),
    'goTo.reports': go(ROUTES.reports),
    'goTo.settings': go(navFor(ADMIN_NAV, session.user)[0]?.path ?? ROUTES.me),
  });
}

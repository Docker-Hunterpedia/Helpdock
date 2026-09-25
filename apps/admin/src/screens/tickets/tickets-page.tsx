import { Box, Button, Drawer, useMediaQuery } from '@mui/material';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TicketIcon } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { ROUTES, ticketIdFromPath, ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession, useTicketsApi } from '../../auth/session.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import { ticketKeys } from '../../tickets/keys.js';
import { mergePages, moveSelection } from '../../tickets/pages.js';
import {
  ALL_VIEW,
  INTENT,
  intentOf,
  queryOf,
  resolveWorkspace,
  viewFiltersOf,
  viewLabel,
  type WorkspaceFilters,
  withFilters,
  withoutFilters,
} from '../../tickets/views.js';
import { useToast } from '../../ui/toasts.tsx';
import { useFilterSummary } from './filter-summary.js';
import { paragraph } from './format.js';
import { shortcutFor } from './keyboard.js';
import { NewTicketDialog, type NewTicketValue } from './new-ticket-dialog.tsx';
import { TICKET_LIST_WIDTH, TicketList } from './ticket-list.tsx';
import { TicketView } from './ticket-view.tsx';
import { useDepartmentRooms } from './use-ticket-realtime.js';
import { useViewActions } from './use-view-actions.js';
import { useContactSearch, useWorkspaceData } from './use-workspace-data.js';
import { SaveViewDialog } from './view-dialogs.tsx';

/**
 * The ticket workspace: `/tickets` and `/tickets/:ticketId` are the same
 * screen, because the list is beside the ticket rather than behind it.
 *
 * **The URL is the state** — the view, the search term and every filter live in
 * the query string and the open ticket is the path — which is the rule the
 * contact screens set: a filtered queue is a link an agent can send, and the
 * back button steps through what they looked at rather than out of the screen.
 * `?view=<id>` names a saved view (M1-05); a filter changed on top of it writes
 * the whole filter set beside it, and `tickets/views.ts` works out what that
 * means — see it for the rules.
 *
 * **The columns of DESIGN §6.5** are 220 · 360 · flexible · 300. Below 1280 px
 * the details panel becomes a drawer; below 1024 px the list does too, which is
 * the same breakpoint at which the shell's own sidebar becomes one.
 */

const DETAILS_BREAKPOINT = '(min-width:1280px)';
const LIST_BREAKPOINT = '(min-width:1024px)';
const SEARCH_DEBOUNCE_MS = 250;

export function TicketsPage(): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const session = useSession();
  const api = useTicketsApi();
  const contactsApi = useContactsApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const ticketId = ticketIdFromPath(pathname);

  const brand = currentBrand(session);
  const wideDetails = useMediaQuery(DETAILS_BREAKPOINT, { noSsr: true });
  const wideList = useMediaQuery(LIST_BREAKPOINT, { noSsr: true });

  const views = useQuery({
    queryKey: ticketKeys.views(brand.id),
    queryFn: () => api.views(brand.id),
  });
  const resolved = useMemo(
    () => resolveWorkspace(views.data?.views ?? [], params),
    [views.data, params],
  );
  const view = resolved.view;
  // The search box is an override on top of the view rather than a change to
  // it: a term typed into a view does not raise "Filters changed".
  const search = params.get('q') ?? resolved.filters.q;
  const filters: WorkspaceFilters = useMemo(
    () => ({ ...resolved.filters, q: search }),
    [resolved.filters, search],
  );

  const [typed, setTyped] = useState(search);
  const [listOpen, setListOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [openFiltersToken, setOpenFiltersToken] = useState<number | null>(null);
  const [contactTerm, setContactTerm] = useState('');
  const [replyFocusToken, setReplyFocusToken] = useState<{
    mode: 'reply' | 'note';
    at: number;
  } | null>(null);

  const directory = useWorkspaceData(brand.id);
  const summary = useFilterSummary(directory);
  const viewActions = useViewActions();
  const contactResults = useContactSearch(brand.id, contactTerm);
  const debounced = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  const now = Date.now();

  useEffect(() => {
    if (debounced !== search) {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (debounced === '' && resolved.filters.q === '') {
            next.delete('q');
          } else {
            next.set('q', debounced);
          }
          return next;
        },
        { replace: true },
      );
    }
  }, [debounced, search, resolved.filters.q, setParams]);

  // An intent from the sidebar is acted on once and dropped from the URL.
  const intent = intentOf(params);
  useEffect(() => {
    if (intent === null) {
      return;
    }
    if (intent === 'filters') {
      setOpenFiltersToken(Date.now());
    } else {
      setSaveOpen(true);
    }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(INTENT);
        return next;
      },
      { replace: true },
    );
  }, [intent, setParams]);

  const query = useMemo(() => queryOf(filters), [filters]);

  // Until the views arrive the URL's `view` means nothing yet, and reading the
  // whole desk meanwhile would flash tickets the view does not hold.
  const viewsSettled = !views.isPending || params.get('view') === ALL_VIEW;

  const list = useInfiniteQuery({
    queryKey: ticketKeys.list(brand.id, query),
    queryFn: ({ pageParam }) =>
      api.list(brand.id, pageParam === null ? query : { ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: viewsSettled,
  });

  const tickets = useMemo(() => mergePages(list.data?.pages ?? []), [list.data]);

  useDepartmentRooms(
    brand.id,
    useMemo(() => tickets.map((ticket) => ticket.departmentId), [tickets]),
  );

  const linkSearch = params.toString() === '' ? '' : `?${params.toString()}`;

  const setFilters = useCallback(
    (next: WorkspaceFilters) => {
      setParams((previous) => withFilters(previous, next));
    },
    [setParams],
  );

  const resetFilters = useCallback(() => {
    setParams((previous) => withoutFilters(previous));
  }, [setParams]);

  const changes =
    view !== null && resolved.changed
      ? {
          // A built-in view never changes its filters, and a shared one only
          // for somebody who manages it: Save is offered where it can succeed.
          canSave: view.editable && view.builtIn === null,
          onReset: resetFilters,
          onSave: () => {
            viewActions.update.mutate(
              { view, request: { filters: viewFiltersOf(filters) } },
              { onSuccess: resetFilters },
            );
          },
          onSaveAsNew: () => {
            setSaveOpen(true);
          },
        }
      : null;

  // -------------------------------------------------------------- keyboard

  /**
   * What the shortcuts act on, read at the moment a key arrives rather than
   * closed over when the listener was attached.
   *
   * The listener is attached once. Re-attaching it whenever the list or the
   * open ticket changed would leave a window — between the navigation and the
   * next render — in which the handler still believed nothing was selected,
   * and `j` pressed twice quickly would open the same ticket twice.
   */
  const latest = useRef({ tickets, ticketId, linkSearch });
  // A layout effect, not a passive one: passive effects run *after* the
  // browser has painted, so for a frame or two the list would be on screen
  // while the handler still believed the old one was. A key pressed in that
  // window would act on what the person is no longer looking at.
  useLayoutEffect(() => {
    latest.current = { tickets, ticketId, linkSearch };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = shortcutFor(event);
      if (shortcut === null) {
        return;
      }

      if (shortcut === 'dismiss') {
        setListOpen(false);
        setDetailsOpen(false);
        return;
      }

      const open = latest.current.ticketId;

      if (shortcut === 'reply' || shortcut === 'note') {
        if (open !== null) {
          event.preventDefault();
          setReplyFocusToken({ mode: shortcut === 'note' ? 'note' : 'reply', at: Date.now() });
        }
        return;
      }

      const next = moveSelection(latest.current.tickets, open, shortcut === 'next' ? 1 : -1);
      if (next !== null && next !== open) {
        event.preventDefault();
        // Recorded before the navigation rather than waiting to be told: this
        // handler is what moved the selection, and `j` held down must step
        // through the list rather than re-open the first row each time.
        latest.current = { ...latest.current, ticketId: next };
        void navigate({ pathname: ticketRoute(next), search: latest.current.linkSearch });
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [navigate]);

  // ------------------------------------------------------------- mutations

  const create = useMutation({
    mutationFn: async (value: NewTicketValue) => {
      const contactId =
        value.contact.kind === 'new'
          ? (
              await contactsApi.createContact(brand.id, {
                name: value.contact.name,
                identities: [{ kind: 'email', value: value.contact.email }],
              })
            ).id
          : value.contact.kind === 'existing'
            ? value.contact.contactId
            : undefined;

      return api.create(brand.id, {
        subject: value.subject,
        bodyHtml: paragraph(value.body),
        departmentId: value.departmentId,
        priority: value.priority,
        channel: 'manual',
        ...(contactId === undefined ? {} : { contactId }),
        clientId: crypto.randomUUID(),
      });
    },
    onSuccess: async (detail) => {
      setDialogOpen(false);
      // The lists and the sidebar counts, not the whole brand: the statuses
      // and the open ticket cannot have changed, and refetching them would
      // make every creation wait on reads nobody is waiting for.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brand.id) }),
        queryClient.invalidateQueries({ queryKey: ticketKeys.counts(brand.id) }),
      ]);
      toast({
        tone: 'success',
        message: t('tickets:toast.created', {
          reference: `${detail.ticket.prefix}-${detail.ticket.number}`,
        }),
      });
      void navigate(ticketRoute(detail.ticket.id));
    },
    onError: () => {
      toast({ tone: 'danger', message: t('tickets:toast.failed') });
    },
  });

  // ---------------------------------------------------------------- render

  const listColumn = (
    <TicketList
      heading={view === null ? t('tickets:views.all') : viewLabel(view, locale)}
      tickets={tickets}
      selectedId={ticketId}
      now={now}
      search={search}
      typed={typed}
      filters={filters}
      statuses={directory.statuses}
      departments={directory.departments}
      tags={directory.tags}
      staff={directory.staff.map((member) => ({ userId: member.userId, name: member.name }))}
      viewerId={session.user.id}
      changes={changes}
      openFiltersToken={openFiltersToken}
      hasMore={list.hasNextPage}
      loading={list.isPending || list.isFetchingNextPage}
      failed={list.isError}
      linkSearch={linkSearch}
      onTypedChange={setTyped}
      onFiltersChange={setFilters}
      onLoadMore={() => {
        void list.fetchNextPage();
      }}
      onRetry={() => {
        void list.refetch();
      }}
      onNewTicket={() => {
        setDialogOpen(true);
      }}
    />
  );

  return (
    <Box
      sx={{
        display: 'flex',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        backgroundColor: tokens['bg.canvas'],
      }}
    >
      {wideList ? (
        listColumn
      ) : (
        <Drawer
          open={listOpen}
          onClose={() => {
            setListOpen(false);
          }}
          slotProps={{ paper: { sx: { width: TICKET_LIST_WIDTH, maxWidth: '100%' } } }}
        >
          {listColumn}
        </Drawer>
      )}

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!wideList ? (
          <Box sx={{ padding: 3, borderBlockEnd: `1px solid ${tokens['border.default']}` }}>
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                setListOpen(true);
              }}
            >
              {t('tickets:list.open')}
            </Button>
          </Box>
        ) : null}

        {ticketId === null ? (
          <Box sx={{ padding: 8 }}>
            {/* No action here: the list beside it already carries the one
                primary action this screen has, and two would be two. */}
            <EmptyState
              icon={TicketIcon}
              heading={t('tickets:empty.noSelectionHeading')}
              body={t('tickets:empty.noSelectionBody')}
            />
          </Box>
        ) : (
          <TicketView
            key={ticketId}
            brandId={brand.id}
            ticketId={ticketId}
            directory={directory}
            viewer={{ id: session.user.id, name: session.user.name }}
            now={now}
            detailsInDrawer={!wideDetails}
            detailsOpen={detailsOpen}
            focusToken={replyFocusToken}
            onDetailsOpenChange={setDetailsOpen}
            onGoToList={() => {
              void navigate({ pathname: ROUTES.tickets, search: linkSearch });
            }}
            onOpenTicket={(next) => {
              void navigate({ pathname: ticketRoute(next), search: linkSearch });
            }}
          />
        )}
      </Box>

      <NewTicketDialog
        open={dialogOpen}
        departments={directory.departments}
        contacts={contactResults}
        busy={create.isPending}
        onTermChange={setContactTerm}
        onSubmit={(value) => {
          create.mutate(value);
        }}
        onClose={() => {
          setDialogOpen(false);
        }}
      />

      <SaveViewDialog
        open={saveOpen}
        summary={summary.sentence(filters, { withSort: true })}
        canShare={session.user.role === 'admin' || session.user.role === 'teamLeader'}
        departments={directory.departments}
        busy={viewActions.busy}
        onClose={() => {
          setSaveOpen(false);
        }}
        onSubmit={(value) => {
          viewActions.create.mutate(
            { ...value, filters: viewFiltersOf(filters) },
            {
              onSuccess: (created) => {
                setSaveOpen(false);
                void navigate({ pathname: ROUTES.tickets, search: `?view=${created.id}` });
              },
            },
          );
        }}
      />
    </Box>
  );
}

/** `value`, but only after it has stopped changing for `delay` milliseconds. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return settled;
}

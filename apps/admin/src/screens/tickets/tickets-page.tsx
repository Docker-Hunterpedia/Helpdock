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
import {
  currentBrand,
  useContactsApi,
  useSession,
  useTicketingApi,
  useTicketsApi,
} from '../../auth/session.tsx';
import { useShortcutHandlers } from '../../keyboard/keyboard-provider.tsx';
import type { ShortcutId } from '../../keyboard/registry.js';
import { EmptyState } from '../../shell/empty-state.tsx';
import { ticketFieldsFor } from '../../tickets/custom-values.js';
import { ticketKeys } from '../../tickets/keys.js';
import { mergePages, moveSelection } from '../../tickets/pages.js';
import {
  headerState,
  keepListed,
  NO_SELECTION,
  range,
  SELECTION_CAP,
  type Selection,
  toggle,
  togglePage,
} from '../../tickets/selection.js';
import {
  ALL_VIEW,
  emptyKindOf,
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
import { BulkBar } from './bulk/bulk-bar.tsx';
import { BulkFieldDialog } from './bulk/bulk-field-dialog.tsx';
import { BulkPreviewDialog } from './bulk/bulk-preview-dialog.tsx';
import { useBulkEdit } from './bulk/use-bulk-edit.tsx';
import { useFilterSummary } from './filter-summary.js';
import { paragraph, ticketReference } from './format.js';
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

/** The list shortcuts the workspace answers; `e` is the open ticket's (`ticket-view.tsx`). */
export const LIST_SHORTCUTS = [
  'list.next',
  'list.previous',
  'list.select',
  'list.selectRange',
  'list.clearSelection',
] as const satisfies readonly ShortcutId[];

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
  const [focusSearchToken, setFocusSearchToken] = useState<number | null>(null);
  const [contactTerm, setContactTerm] = useState('');

  const directory = useWorkspaceData(brand.id);
  const summary = useFilterSummary(directory);
  // A field hidden from Agents is not a filter for them (the api refuses it too).
  const filterableFields = ticketFieldsFor(
    directory.fields,
    session.user.role === 'admin' || session.user.role === 'teamLeader',
  );
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
    } else if (intent === 'save') {
      setSaveOpen(true);
    } else if (intent === 'new') {
      setDialogOpen(true);
    } else {
      // `/` (M14-01). Below 1024 px the search box is in the list's drawer.
      setListOpen(true);
      setFocusSearchToken(Date.now());
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

  // ------------------------------------------------------------- selection

  // M14-04. A reader without `ticket:write` gets the list as it was.
  const canWrite = session.user.role !== 'viewer';
  const listedIds = useMemo(() => tickets.map((ticket) => ticket.id), [tickets]);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [capped, setCapped] = useState(false);
  const [fieldOpen, setFieldOpen] = useState(false);
  const headerCheckbox = useRef<HTMLInputElement | null>(null);
  const selectedIds = useMemo(() => new Set(selection.ids), [selection.ids]);
  // In list order, so a preview reads in the order the person sees the rows.
  const selectedInListOrder = useMemo(
    () => listedIds.filter((id) => selectedIds.has(id)),
    [listedIds, selectedIds],
  );
  const selectedTickets = useMemo(
    () => tickets.filter((ticket) => selectedIds.has(ticket.id)),
    [tickets, selectedIds],
  );
  const ticketingApi = useTicketingApi();
  const fieldDefs = useQuery({
    queryKey: ['custom-fields', brand.id],
    queryFn: () => ticketingApi.customFields(brand.id),
    staleTime: 60_000,
    enabled: canWrite && selection.ids.length > 0,
  });

  // A different view, filter or search is a different list: nothing carries over.
  const listKey = JSON.stringify(query);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `listKey` is the trigger; the body does not read it.
  useEffect(() => {
    setSelection(NO_SELECTION);
    setCapped(false);
  }, [listKey]);

  // A row that left the list (closed elsewhere, moved) is no longer selected,
  // so the count never names a ticket the person cannot see. A realtime
  // refresh that keeps the rows keeps the selection.
  useEffect(() => {
    setSelection((held) => keepListed(held, listedIds));
  }, [listedIds]);

  const refocusHeader = useCallback((): void => {
    // After the bar has gone, so focus does not fall to the page.
    requestAnimationFrame(() => {
      headerCheckbox.current?.focus();
    });
  }, []);

  const clearSelection = useCallback(
    (focus: boolean): void => {
      setSelection(NO_SELECTION);
      setCapped(false);
      if (focus) {
        refocusHeader();
      }
    },
    [refocusHeader],
  );

  const bulk = useBulkEdit({
    brandId: brand.id,
    ticketIds: selectedInListOrder,
    onDone: () => {
      clearSelection(true);
    },
  });

  const count = selection.ids.length;
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef(0);
  useEffect(() => {
    if (count === announced.current) {
      return;
    }
    announced.current = count;
    setAnnouncement(
      count === 0 ? t('tickets:bulk.announceNone') : t('tickets:bulk.announce', { count }),
    );
  }, [count, t]);

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
   * closed over when the handler was attached.
   *
   * The handlers are attached once. Re-attaching them whenever the list or the
   * open ticket changed would leave a window — between the navigation and the
   * next render — in which the handler still believed nothing was selected,
   * and `j` pressed twice quickly would open the same ticket twice.
   */
  const latest = useRef({ tickets, ticketId, linkSearch, listedIds, selection });
  // A layout effect, not a passive one: passive effects run *after* the
  // browser has painted, so for a frame or two the list would be on screen
  // while the handler still believed the old one was. A key pressed in that
  // window would act on what the person is no longer looking at.
  useLayoutEffect(() => {
    latest.current = { tickets, ticketId, linkSearch, listedIds, selection };
  });

  const move = (step: 1 | -1): void => {
    const open = latest.current.ticketId;
    const next = moveSelection(latest.current.tickets, open, step);
    if (next !== null && next !== open) {
      // A row still holding focus from a click would be "the focused row" for
      // `x` while the open ticket has moved on, so focus leaves the list.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[data-ticket-id]') !== null) {
        active.blur();
      }
      // Recorded before the navigation rather than waiting to be told: this
      // handler is what moved the selection, and `j` held down must step
      // through the list rather than re-open the first row each time.
      latest.current = { ...latest.current, ticketId: next };
      void navigate({ pathname: ticketRoute(next), search: latest.current.linkSearch });
    }
  };

  /**
   * The row `x` acts on: the one holding focus (Tab, or a click on its box),
   * else the open ticket. `j`/`k` move the open ticket, so selecting down the
   * list is `j`, `x`, `j`, `x`.
   */
  const focusedRow = (): string | null => {
    const active = document.activeElement;
    const row = active instanceof Element ? active.closest('[data-ticket-id]') : null;

    return row?.getAttribute('data-ticket-id') ?? latest.current.ticketId;
  };

  const change = (result: { selection: Selection; capped: boolean }): void => {
    setSelection(result.selection);
    setCapped(result.capped);
  };

  useShortcutHandlers<(typeof LIST_SHORTCUTS)[number]>({
    'list.next': () => {
      move(1);
    },
    'list.previous': () => {
      move(-1);
    },
    'list.select': canWrite
      ? () => {
          const id = focusedRow();
          if (id !== null && latest.current.listedIds.includes(id)) {
            change(toggle(latest.current.selection, id));
          }
        }
      : null,
    'list.selectRange': canWrite
      ? () => {
          const id = focusedRow();
          if (id !== null) {
            change(range(latest.current.selection, id, latest.current.listedIds));
          }
        }
      : null,
    // Attached only while something is ticked, so Esc is the page's otherwise.
    'list.clearSelection':
      canWrite && selection.ids.length > 0
        ? () => {
            const active = document.activeElement;
            const inBar = active instanceof Element && active.closest('[role="toolbar"]') !== null;
            clearSelection(inBar || active === document.body);
          }
        : null,
  });

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
      emptyKind={emptyKindOf(view, search, filters, resolved.changed)}
      typed={typed}
      filters={filters}
      statuses={directory.statuses}
      departments={directory.departments}
      tags={directory.tags}
      staff={directory.staff.map((member) => ({ userId: member.userId, name: member.name }))}
      fields={filterableFields}
      pinnedField={directory.fields.find((def) => def.pinned && def.target === 'ticket')}
      viewerId={session.user.id}
      changes={changes}
      openFiltersToken={openFiltersToken}
      focusSearchToken={focusSearchToken}
      hasMore={list.hasNextPage}
      loading={list.isPending || list.isFetchingNextPage}
      failed={list.isError}
      linkSearch={linkSearch}
      selection={
        canWrite
          ? {
              ids: selectedIds,
              header: headerState(selection, listedIds),
              capped,
              max: SELECTION_CAP,
              headerRef: headerCheckbox,
              announcement,
              bar:
                count === 0 ? null : (
                  <BulkBar
                    brandId={brand.id}
                    count={count}
                    firstTicketId={selectedInListOrder[0] ?? ''}
                    departmentIds={[
                      ...new Set(selectedTickets.map((ticket) => ticket.departmentId)),
                    ]}
                    statuses={directory.statuses}
                    departments={directory.departments}
                    tags={directory.tags}
                    busy={bulk.busy}
                    onChoose={bulk.start}
                    onMoreField={() => {
                      setFieldOpen(true);
                    }}
                    onClear={() => {
                      clearSelection(true);
                    }}
                  />
                ),
              onSelect: (id, extend) => {
                change(extend ? range(selection, id, listedIds) : toggle(selection, id));
              },
              onSelectPage: () => {
                change(togglePage(selection, listedIds));
              },
            }
          : undefined
      }
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

      <BulkPreviewDialog
        choice={bulk.review?.choice ?? null}
        summary={bulk.review?.summary ?? null}
        refreshed={bulk.review?.refreshed ?? false}
        applying={bulk.applying}
        referenceOf={(id) => {
          const found = tickets.find((ticket) => ticket.id === id);
          return found === undefined ? id.slice(0, 8) : ticketReference(found);
        }}
        onConfirm={bulk.confirm}
        onCancel={bulk.cancel}
      />

      <BulkFieldDialog
        open={fieldOpen}
        fields={ticketFieldsFor(
          fieldDefs.data?.fields ?? [],
          session.user.role === 'admin' || session.user.role === 'teamLeader',
        )}
        onClose={() => {
          setFieldOpen(false);
        }}
        onSubmit={(key, value) => {
          setFieldOpen(false);
          bulk.start({ kind: 'field', key, value });
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

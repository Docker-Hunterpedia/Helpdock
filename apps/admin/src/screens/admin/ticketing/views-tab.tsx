import type { TicketView } from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  EllipsisVertical,
  Eye,
  EyeOff,
  GripVertical,
  Info,
  ListFilter,
  Pencil,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketsApi } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { ticketKeys } from '../../../tickets/keys.js';
import { filtersOfView, viewLabel } from '../../../tickets/views.js';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useFilterSummary } from '../../tickets/filter-summary.js';
import { useWorkspaceData } from '../../tickets/use-workspace-data.js';
import { moveBy, moveTo } from './reorder.js';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';
import { createRequestOf, updateRequestOf, type ViewDraft } from './view-draft.js';
import { ViewEditor } from './view-editor.tsx';

/**
 * The Views tab of `Admin/Ticketing` (M1-05, `Admin/Ticketing-Views`): the
 * brand's shared views in sidebar order, the built-in defaults among them, and
 * the 300 px editor card beside the table — the anatomy of the Tags tab.
 *
 * **What a row may do is the api's `editable`.** An Admin edits every shared
 * view; a Team Leader edits those shared with departments they lead, and sees
 * the rest read-only. A built-in view is renamed, reordered and hidden, never
 * deleted or refiltered — the card draws its filters disabled, and the menu has
 * no Delete.
 *
 * **Reordering sends only the views the reader may move.** The api puts them
 * back in the places they held between them, so a Team Leader's drag never
 * names a view they have no say over.
 */
export function ViewsTab(): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const api = useTicketsApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const brand = currentBrand(session);
  const directory = useWorkspaceData(brand.id);
  const summary = useFilterSummary(directory);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<{ view: TicketView; anchor: HTMLElement } | null>(null);
  const [confirming, setConfirming] = useState<TicketView | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const views = useQuery({
    queryKey: ticketKeys.views(brand.id),
    queryFn: () => api.views(brand.id),
  });
  const counts = useQuery({
    queryKey: ticketKeys.counts(brand.id),
    queryFn: () => api.viewCounts(brand.id),
  });

  const rows = (views.data?.views ?? []).filter((view) => view.visibility.kind !== 'personal');
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const order = rows.map((row) => row.id);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ticketKeys.views(brand.id) }),
      queryClient.invalidateQueries({ queryKey: ticketKeys.counts(brand.id) }),
    ]);
  };

  const create = useTicketingAction(
    (draft: ViewDraft) => api.createView(brand.id, createRequestOf(draft)),
    (draft) => t('ticketing:toast.viewCreated', { name: draft.name.trim() }),
    refresh,
    report,
  );

  const update = useTicketingAction(
    (input: { view: TicketView; draft: ViewDraft }) =>
      api.updateView(brand.id, input.view.id, updateRequestOf(input.view, input.draft)),
    (input) => t('ticketing:toast.viewUpdated', { name: input.draft.name.trim() }),
    refresh,
    report,
  );

  const toggleHidden = useTicketingAction(
    (view: TicketView) => api.updateView(brand.id, view.id, { hidden: !view.hidden }),
    (view) =>
      t(view.hidden ? 'ticketing:toast.viewShown' : 'ticketing:toast.viewHidden', {
        name: viewLabel(view, locale),
      }),
    refresh,
    report,
  );

  const remove = useTicketingAction(
    (view: TicketView) => api.deleteView(brand.id, view.id),
    (view) => t('ticketing:toast.viewDeleted', { name: viewLabel(view, locale) }),
    refresh,
    report,
  );

  const reorder = useTicketingAction(
    (next: readonly string[]) => api.reorderViews(brand.id, next),
    () => t('ticketing:toast.reordered'),
    refresh,
    report,
  );

  const busy = [create, update, toggleHidden, remove, reorder].some(
    (mutation) => mutation.isPending,
  );

  const applyOrder = (next: readonly string[]): void => {
    if (next === order) {
      return;
    }
    const movable = next.filter((id) => rows.find((row) => row.id === id)?.editable === true);
    if (movable.length > 0) {
      reorder.mutate(movable);
    }
  };

  const audienceOf = (view: TicketView): string =>
    view.visibility.kind === 'departments'
      ? view.visibility.departmentIds
          .map(
            (id) =>
              directory.departments.find((department) => department.id === id)?.name ??
              id.slice(0, 8),
          )
          .join(', ')
      : t('ticketing:views.everyone');

  const countOf = (view: TicketView): string => {
    const found = counts.data?.counts.find((count) => count.viewId === view.id);
    if (found === undefined) {
      return '';
    }
    return found.capped
      ? t('tickets:views.partialCount', { count: found.count })
      : String(found.count);
  };

  const menuView = menuFor?.view ?? null;

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
      <Box sx={{ flex: '1 1 560px', maxWidth: 900, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, marginBlockEnd: 4 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h3" component="h2">
              {t('ticketing:views.heading')}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('ticketing:views.body')}
            </Typography>
          </Box>
          <Button
            variant="contained"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          >
            {t('ticketing:views.add')}
          </Button>
        </Box>

        {rows.length === 0 && !views.isPending ? (
          <EmptyState
            icon={ListFilter}
            heading={t('ticketing:views.empty.heading')}
            body={t('ticketing:views.empty.body')}
          />
        ) : (
          <TableContainer
            sx={{
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            <Table aria-label={t('ticketing:views.table.caption', { brand: brand.name })}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell />
                  <TableCell>{t('ticketing:views.table.view')}</TableCell>
                  <TableCell>{t('ticketing:views.table.shows')}</TableCell>
                  <TableCell>{t('ticketing:views.table.visibleTo')}</TableCell>
                  <TableCell align="right">{t('ticketing:views.table.tickets')}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((view) => {
                  const name = viewLabel(view, locale);
                  return (
                    <TableRow
                      key={view.id}
                      onDragOver={(event) => {
                        event.preventDefault();
                      }}
                      onDrop={() => {
                        if (dragging !== null && dragging !== view.id) {
                          applyOrder(moveTo(order, dragging, order.indexOf(view.id)));
                        }
                        setDragging(null);
                      }}
                      sx={{
                        height: 48,
                        backgroundColor:
                          view.id === selectedId ? tokens['action.primary.tint'] : undefined,
                      }}
                    >
                      <TableCell sx={{ width: 40 }}>
                        <IconButton
                          aria-label={t('ticketing:views.table.dragHandle', { name })}
                          draggable
                          disabled={busy || !view.editable}
                          onDragStart={() => {
                            setDragging(view.id);
                          }}
                          onDragEnd={() => {
                            setDragging(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                              event.preventDefault();
                              applyOrder(moveBy(order, view.id, event.key === 'ArrowUp' ? -1 : 1));
                            }
                          }}
                        >
                          <GripVertical size={16} aria-hidden="true" />
                        </IconButton>
                      </TableCell>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <Button
                            variant="text"
                            aria-label={t('ticketing:views.table.select', { name })}
                            disabled={!view.editable}
                            onClick={() => {
                              setCreating(false);
                              setSelectedId(view.id);
                            }}
                            sx={{ justifyContent: 'flex-start', paddingInline: 0, minWidth: 0 }}
                          >
                            {name}
                          </Button>
                          {view.builtIn === null ? null : (
                            <Badge>{t('ticketing:views.builtIn')}</Badge>
                          )}
                          {view.hidden ? <Badge>{t('ticketing:views.hidden')}</Badge> : null}
                        </Box>
                      </TableCell>
                      <TableCell
                        sx={{
                          color: 'text.secondary',
                          maxWidth: 280,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {summary.sentence(filtersOfView(view.filters))}
                      </TableCell>
                      <TableCell>{audienceOf(view)}</TableCell>
                      <TableCell align="right">
                        <Typography variant="mono" component="span">
                          {countOf(view)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <IconButton
                          aria-label={t('ticketing:views.table.rowActions', { name })}
                          aria-haspopup="menu"
                          disabled={busy || !view.editable}
                          onClick={(event) => {
                            setMenuFor({ view, anchor: event.currentTarget });
                          }}
                        >
                          <EllipsisVertical size={16} aria-hidden="true" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      <Box
        sx={{ flex: '0 0 320px', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        {creating || selected !== null ? (
          <ViewEditor
            view={selected}
            departments={directory.departments}
            tags={directory.tags}
            busy={busy}
            onSubmit={(draft) => {
              if (selected === null) {
                create.mutate(draft, {
                  onSuccess: (created) => {
                    setCreating(false);
                    setSelectedId(created.id);
                  },
                });
                return;
              }
              update.mutate({ view: selected, draft });
            }}
            onCancel={() => {
              setCreating(false);
              setSelectedId(null);
            }}
            {...(selected === null || selected.builtIn !== null
              ? {}
              : {
                  onDelete: () => {
                    setConfirming(selected);
                  },
                })}
          />
        ) : (
          <EmptyState
            icon={Pencil}
            heading={t('ticketing:views.editor.nothing.heading')}
            body={t('ticketing:views.editor.nothing.body')}
          />
        )}
        <Box
          sx={{
            display: 'flex',
            gap: 3,
            padding: 4,
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
          }}
        >
          <Info size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:views.note')}
          </Typography>
        </Box>
      </Box>

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
        slotProps={{
          list: {
            'aria-label': t('ticketing:views.table.rowActions', {
              name: menuView === null ? '' : viewLabel(menuView, locale),
            }),
          },
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuView !== null) {
              setCreating(false);
              setSelectedId(menuView.id);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:views.actions.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuView !== null) {
              applyOrder(moveBy(order, menuView.id, -1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowUp size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:views.actions.moveUp')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuView !== null) {
              applyOrder(moveBy(order, menuView.id, 1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowDown size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:views.actions.moveDown')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuView !== null) {
              toggleHidden.mutate(menuView);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            {menuView?.hidden === true ? (
              <Eye size={16} aria-hidden="true" />
            ) : (
              <EyeOff size={16} aria-hidden="true" />
            )}
          </ListItemIcon>
          {menuView?.hidden === true
            ? t('ticketing:views.actions.show')
            : t('ticketing:views.actions.hide')}
        </MenuItem>
        {menuView?.builtIn == null ? (
          <MenuItem
            onClick={() => {
              setConfirming(menuView);
              setMenuFor(null);
            }}
          >
            <ListItemIcon>
              <Trash2 size={16} aria-hidden="true" />
            </ListItemIcon>
            {t('ticketing:views.actions.delete')}
          </MenuItem>
        ) : null}
      </Menu>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        title={t('ticketing:views.confirm.title', {
          name: confirming === null ? '' : viewLabel(confirming, locale),
        })}
        body={t('ticketing:views.confirm.body')}
        confirmLabel={t('ticketing:views.confirm.submit')}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming !== null) {
            remove.mutate(confirming, {
              onSuccess: () => {
                setSelectedId(null);
              },
            });
          }
          setConfirming(null);
        }}
      />
    </Box>
  );
}

/** The small neutral label beside a view's name: "built-in", "hidden". */
function Badge({ children }: { readonly children: ReactNode }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Typography
      component="span"
      variant="caption"
      sx={{
        paddingInline: 2,
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        color: tokens['text.secondary'],
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Typography>
  );
}

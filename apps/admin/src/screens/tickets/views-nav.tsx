import type { TicketView, TicketViewCount } from '@helpdock/schemas';
import { Box, IconButton, ListItemIcon, Menu, MenuItem, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, ListFilter, Pencil, Plus, Share2, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useSession, useTicketsApi } from '../../auth/session.tsx';
import { ticketKeys } from '../../tickets/keys.js';
import {
  ALL_VIEW,
  INTENT,
  selectedViewId,
  sidebarViews,
  viewLabel,
  viewSearch,
} from '../../tickets/views.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { useViewActions } from './use-view-actions.js';
import { useDepartments } from './use-workspace-data.js';
import { RenameViewDialog, ShareViewDialog } from './view-dialogs.tsx';

/**
 * The "Views" group of DESIGN §6.5 (M1-05, `Admin/View-Dialogs` panels 1–2):
 * the brand's shared views in the order Ticketing › Views gives them, then the
 * reader's own under "Mine", each a 32 px row with a mono count and a ⋯ menu
 * that appears on hover and on focus.
 *
 * Names and counts are two reads. The names come first and the rows are
 * usable at once; the counts — one capped statement for the whole group on the
 * api — fill in when they arrive, and a count past the cap reads "999+".
 *
 * The menu offers what the reader may do, as the api says in `editable`: a
 * built-in view is renamed only (Ticketing › Views hides it), a shared one is
 * never re-shared from here, and "Share with…" is for the roles that manage
 * ticketing. The api refuses anything else whatever the menu drew.
 */

const COUNT_STALE_MS = 30_000;

export function TicketViewsNav({
  onNavigate,
}: {
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const session = useSession();
  const api = useTicketsApi();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [params] = useSearchParams();
  const labelId = useId();
  const mineId = useId();
  const brand = currentBrand(session);
  const actions = useViewActions();

  const [menuFor, setMenuFor] = useState<{ view: TicketView; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<TicketView | null>(null);
  const [sharing, setSharing] = useState<TicketView | null>(null);
  const departments = useDepartments(brand.id, sharing !== null);
  const [deleting, setDeleting] = useState<TicketView | null>(null);

  const views = useQuery({
    queryKey: ticketKeys.views(brand.id),
    queryFn: () => api.views(brand.id),
  });
  const counts = useQuery({
    queryKey: ticketKeys.counts(brand.id),
    queryFn: () => api.viewCounts(brand.id),
    staleTime: COUNT_STALE_MS,
  });

  const all = views.data?.views ?? [];
  const { shared, mine } = sidebarViews(all);
  const onTickets = pathname === ROUTES.tickets || pathname.startsWith(`${ROUTES.tickets}/`);
  const selected = onTickets ? selectedViewId(all, params) : null;
  const manages = session.user.role === 'admin' || session.user.role === 'teamLeader';

  const countOf = (view: TicketView): string | undefined => {
    const found = counts.data?.counts.find((count: TicketViewCount) => count.viewId === view.id);
    if (found === undefined) {
      return undefined;
    }

    return found.capped
      ? t('tickets:views.partialCount', { count: found.count })
      : String(found.count);
  };

  // "Save as a view" keeps whatever the list shows now; from any other screen
  // it saves the desk as the first view opens it.
  const saveLink = (() => {
    const next = new URLSearchParams(onTickets ? search : '');
    next.set(INTENT, 'save');
    return `${ROUTES.tickets}?${next.toString()}`;
  })();

  const row = (view: TicketView) => (
    <ViewLink
      key={view.id}
      label={viewLabel(view, locale)}
      to={`${ROUTES.tickets}${viewSearch(view.id)}`}
      active={selected === view.id}
      count={countOf(view)}
      // DESIGN §2.3: Overdue is the one view whose number is a warning, and it
      // is a number in the danger hue only while there is one.
      danger={view.builtIn === 'overdue' && (countOf(view) ?? '0') !== '0'}
      onNavigate={onNavigate}
      {...(view.editable
        ? {
            onMenu: (anchor: HTMLElement) => {
              setMenuFor({ view, anchor });
            },
            menuLabel: t('tickets:views.actions', { name: viewLabel(view, locale) }),
          }
        : {})}
    />
  );

  const menuView = menuFor?.view ?? null;
  const personal = menuView?.visibility.kind === 'personal';
  const builtIn = menuView?.builtIn != null;

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          paddingInline: 3,
          marginBlock: '16px 4px',
        }}
      >
        <Typography
          id={labelId}
          component="p"
          variant="caption"
          sx={{ color: 'text.secondary', fontSize: 11, flex: 1 }}
        >
          {t('tickets:views.label')}
        </Typography>
        <IconButton
          size="small"
          component={Link}
          to={saveLink}
          onClick={onNavigate}
          aria-label={t('tickets:views.new')}
          sx={{ width: 24, height: 24 }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </Box>

      <Box
        component="ul"
        aria-labelledby={labelId}
        sx={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        <ViewLink
          label={t('tickets:views.all')}
          to={`${ROUTES.tickets}${viewSearch(ALL_VIEW)}`}
          active={selected === ALL_VIEW}
          onNavigate={onNavigate}
        />
        {shared.map(row)}
      </Box>

      {mine.length === 0 ? null : (
        <>
          <Typography
            id={mineId}
            component="p"
            variant="caption"
            sx={{
              color: 'text.secondary',
              paddingInline: 3,
              marginBlock: '12px 4px',
              fontSize: 11,
            }}
          >
            {t('tickets:views.mine')}
          </Typography>
          <Box
            component="ul"
            aria-labelledby={mineId}
            sx={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {mine.map(row)}
          </Box>
        </>
      )}

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
        slotProps={{
          list: {
            'aria-label': t('tickets:views.actions', {
              name: menuView === null ? '' : viewLabel(menuView, locale),
            }),
          },
        }}
      >
        {builtIn ? null : (
          <MenuItem
            onClick={() => {
              if (menuView !== null) {
                onNavigate?.();
                void navigate(`${ROUTES.tickets}${viewSearch(menuView.id, 'filters')}`);
              }
              setMenuFor(null);
            }}
          >
            <ListItemIcon>
              <ListFilter size={16} aria-hidden="true" />
            </ListItemIcon>
            {t('tickets:views.edit')}
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            setRenaming(menuView);
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('tickets:views.rename')}
        </MenuItem>
        {personal && manages ? (
          <MenuItem
            onClick={() => {
              setSharing(menuView);
              setMenuFor(null);
            }}
          >
            <ListItemIcon>
              <Share2 size={16} aria-hidden="true" />
            </ListItemIcon>
            {t('tickets:views.share')}
          </MenuItem>
        ) : null}
        {builtIn ? null : (
          <MenuItem
            onClick={() => {
              setDeleting(menuView);
              setMenuFor(null);
            }}
          >
            <ListItemIcon>
              <Trash2 size={16} aria-hidden="true" />
            </ListItemIcon>
            {t('tickets:views.delete')}
          </MenuItem>
        )}
      </Menu>

      <RenameViewDialog
        view={renaming}
        busy={actions.busy}
        onClose={() => {
          setRenaming(null);
        }}
        onSubmit={(name) => {
          if (renaming !== null) {
            actions.update.mutate(
              { view: renaming, request: { name } },
              {
                onSuccess: () => {
                  setRenaming(null);
                },
              },
            );
          }
        }}
      />

      <ShareViewDialog
        view={sharing}
        departments={departments}
        busy={actions.busy}
        onClose={() => {
          setSharing(null);
        }}
        onSubmit={(departmentIds) => {
          if (sharing !== null) {
            actions.update.mutate(
              {
                view: sharing,
                request: { visibility: { kind: 'departments', departmentIds: [...departmentIds] } },
              },
              {
                onSuccess: () => {
                  setSharing(null);
                },
              },
            );
          }
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        destructive
        busy={actions.busy}
        title={t('tickets:viewDialog.deleteTitle', {
          name: deleting === null ? '' : viewLabel(deleting, locale),
        })}
        body={t('tickets:viewDialog.deleteBody')}
        confirmLabel={t('tickets:viewDialog.deleteSubmit')}
        onClose={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting !== null) {
            const gone = deleting;
            actions.remove.mutate(gone, {
              onSuccess: () => {
                // The sidebar should not stay on a view that no longer exists.
                if (selected === gone.id) {
                  void navigate(ROUTES.tickets);
                }
              },
            });
          }
          setDeleting(null);
        }}
      />
    </>
  );
}

function ViewLink({
  label,
  to,
  active,
  count,
  danger = false,
  onNavigate,
  onMenu,
  menuLabel,
}: {
  readonly label: string;
  readonly to: string;
  readonly active: boolean;
  readonly count?: string | undefined;
  readonly danger?: boolean;
  readonly onNavigate?: (() => void) | undefined;
  /** Present when the reader may change the view: draws the ⋯ button. */
  readonly onMenu?: (anchor: HTMLElement) => void;
  readonly menuLabel?: string;
}): ReactNode {
  const palette = useSemanticTokens();

  return (
    <Box
      component="li"
      sx={{
        position: 'relative',
        borderRadius: '6px',
        backgroundColor: active ? palette['bg.muted'] : 'transparent',
        '&:hover': { backgroundColor: palette['bg.muted'] },
        // Panel 1: the ⋯ appears on hover and on focus, and stands in for the
        // count while it does.
        '&:hover .view-menu, &:focus-within .view-menu': { opacity: 1 },
        '&:hover .view-count, &:focus-within .view-count': onMenu ? { opacity: 0 } : {},
      }}
    >
      {/* A plain `Link`, not a `NavLink`: every view is the same *path* and
          differs only by query, so `NavLink` would mark all of them current.
          The selected one is decided here, from the parameter. */}
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={active ? 'true' : undefined}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            height: 32,
            paddingInline: 3,
            fontWeight: active ? 500 : 400,
          }}
        >
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{ flex: 1, fontWeight: 'inherit' }}
          >
            {label}
          </Typography>
          {count === undefined ? null : (
            <Typography
              component="span"
              variant="mono"
              className="view-count"
              sx={{ color: danger ? palette['status.danger.text'] : 'text.secondary' }}
            >
              {count}
            </Typography>
          )}
        </Box>
      </Link>
      {onMenu === undefined ? null : (
        <IconButton
          className="view-menu"
          size="small"
          aria-label={menuLabel}
          aria-haspopup="menu"
          onClick={(event) => {
            onMenu(event.currentTarget);
          }}
          sx={{
            position: 'absolute',
            insetInlineEnd: 4,
            insetBlockStart: 4,
            width: 24,
            height: 24,
            opacity: 0,
            '&:focus-visible': { opacity: 1 },
          }}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </IconButton>
      )}
    </Box>
  );
}

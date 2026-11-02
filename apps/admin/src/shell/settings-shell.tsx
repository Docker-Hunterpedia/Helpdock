import { Box } from '@mui/material';
import { type ReactNode, useMemo } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { useSession } from '../auth/session.tsx';
import { SettingsHeaderContext } from './settings-header.js';
import { firstSettingsPath, settingsEntryAt, settingsGroupLabelKey } from './settings-nav.js';

/** Settings pages share one reading width (`Admin/UX-Fixes-2026-11`). */
const SETTINGS_CONTENT_MAX = 1040;

/**
 * The Settings area's page frame. Its pages are listed in the main sidebar
 * (`sidebar-tree.tsx`), so the shell draws no navigation of its own: it gives
 * the page header its breadcrumb and title through `SettingsHeaderContext`
 * and caps the page at one reading width. A new page opens at the top, and a
 * `#fragment` scrolls to its section (`route-scroll.ts`, in the app shell).
 */
export function SettingsShell(): ReactNode {
  const t = useT();
  const { pathname } = useLocation();
  const current = settingsEntryAt(pathname);
  const exact = current !== undefined && pathname.replace(/\/$/, '') === current.path;
  const settingsLabel = t('admin:nav.settings');

  const header = useMemo(
    () =>
      current === undefined
        ? null
        : {
            crumbs: [settingsLabel, t(settingsGroupLabelKey(current.group) as never)],
            title: exact ? t(current.labelKey as never) : undefined,
          },
    [current, exact, settingsLabel, t],
  );

  return (
    <Box sx={{ minHeight: '100dvh', paddingBlock: 5, paddingInline: { xs: 4, md: 6 } }}>
      <Box sx={{ maxInlineSize: SETTINGS_CONTENT_MAX }}>
        <SettingsHeaderContext.Provider value={header}>
          <Outlet />
        </SettingsHeaderContext.Provider>
      </Box>
    </Box>
  );
}

/** `/settings` and a bare group path: the first page the person is offered. */
export function SettingsLanding(): ReactNode {
  const session = useSession();
  return <Navigate to={firstSettingsPath(session.user)} replace />;
}

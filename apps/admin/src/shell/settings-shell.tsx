import {
  Box,
  createTheme,
  type Theme,
  ThemeProvider,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { type ReactNode, useCallback, useMemo } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { useSession } from '../auth/session.tsx';
import { SettingsHeaderContext } from './settings-header.js';
import {
  firstSettingsPath,
  type SettingsEntry,
  type SettingsGroupId,
  settingsEntryAt,
  settingsFor,
  settingsGroupLabelKey,
} from './settings-nav.js';

const NAV_WIDTH = 220;
/** The width from which the navigation sits beside the page instead of above it. */
const BESIDE = '(min-width:900px)';

/**
 * The pages were laid out against the whole window, so their two-column
 * breakpoints (`lg`, `xl`) are window widths. Beside the navigation a page has
 * `NAV_WIDTH` less, and a layout that fits at 1200 px of window would be
 * cramped at 1200 px with a 220 px column taken, so for everything below the
 * shell every breakpoint is that much further along. The pages stay as they
 * were.
 */
function shiftBreakpoints(outer: Theme): Theme {
  const { values } = outer.breakpoints;
  // The values go in the options, not on the result: the breakpoint helpers
  // (`up`, `down`) are built from them when the theme is created.
  return createTheme({
    ...outer,
    breakpoints: {
      values: {
        xs: values.xs,
        sm: values.sm + NAV_WIDTH,
        md: values.md + NAV_WIDTH,
        lg: values.lg + NAV_WIDTH,
        xl: values.xl + NAV_WIDTH,
      },
    },
  });
}

/**
 * The Settings area (M14-21, `Admin/Settings-Shell`): a grouped secondary
 * navigation beside the page. The pages keep their own content and header; the
 * shell gives the header its breadcrumb and title through
 * `SettingsHeaderContext`. Below 900 px the navigation sits above the page, as
 * the board defines no narrower layout.
 */
export function SettingsShell(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const { pathname } = useLocation();
  const groups = settingsFor(session.user);
  const current = settingsEntryAt(pathname);
  const exact = current !== undefined && pathname.replace(/\/$/, '') === current.path;
  const settingsLabel = t('admin:nav.settings');
  const beside = useMediaQuery(BESIDE, { noSsr: true });
  const pageTheme = useCallback(
    (outer: Theme): Theme => (beside ? shiftBreakpoints(outer) : outer),
    [beside],
  );

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
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        alignItems: 'stretch',
        minHeight: '100dvh',
      }}
    >
      <Box
        component="nav"
        aria-label={t('admin:settings.navLabel')}
        sx={{
          flexShrink: 0,
          boxSizing: 'border-box',
          width: { xs: '100%', md: NAV_WIDTH },
          padding: 3,
          backgroundColor: tokens['bg.surface'],
          borderInlineEnd: { md: `1px solid ${tokens['border.default']}` },
          borderBlockEnd: { xs: `1px solid ${tokens['border.default']}`, md: 0 },
        }}
      >
        {groups.map(({ group, entries }) => (
          <SettingsGroup key={group} group={group} entries={entries} activeId={current?.id} />
        ))}
      </Box>
      <Box
        component="div"
        sx={{ flex: 1, minWidth: 0, paddingBlock: 5, paddingInline: { xs: 4, md: 6 } }}
      >
        <ThemeProvider theme={pageTheme}>
          <SettingsHeaderContext.Provider value={header}>
            <Outlet />
          </SettingsHeaderContext.Provider>
        </ThemeProvider>
      </Box>
    </Box>
  );
}

function SettingsGroup({
  group,
  entries,
  activeId,
}: {
  readonly group: SettingsGroupId;
  readonly entries: readonly SettingsEntry[];
  readonly activeId: string | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const headingId = `settings-group-${group}`;

  return (
    <>
      <Typography
        id={headingId}
        component="p"
        variant="caption"
        sx={{
          color: 'text.secondary',
          fontSize: 12,
          fontWeight: 600,
          paddingBlock: '12px 4px',
          paddingInline: 3,
          // DESIGN §3.2: uppercase section labels are regular case in Arabic.
          textTransform: locale === 'ar' ? 'none' : 'uppercase',
          letterSpacing: locale === 'ar' ? 0 : '0.04em',
        }}
      >
        {t(settingsGroupLabelKey(group) as never)}
      </Typography>
      <Box
        component="ul"
        aria-labelledby={headingId}
        sx={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {entries.map((entry) => {
          const active = entry.id === activeId;
          return (
            <Box component="li" key={entry.id}>
              <Link
                to={entry.path}
                aria-current={active ? 'page' : undefined}
                style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
              >
                <Box
                  sx={{
                    boxSizing: 'border-box',
                    minHeight: 32,
                    display: 'flex',
                    alignItems: 'center',
                    paddingBlock: 1,
                    paddingInline: 3,
                    borderRadius: '6px',
                    fontSize: 13,
                    lineHeight: '18px',
                    fontWeight: active ? 500 : 400,
                    color: entry.danger ? tokens['status.danger.text'] : 'inherit',
                    backgroundColor: active ? tokens['bg.muted'] : 'transparent',
                    '&:hover': { backgroundColor: tokens['bg.muted'] },
                  }}
                >
                  {t(entry.labelKey as never)}
                </Box>
              </Link>
            </Box>
          );
        })}
      </Box>
    </>
  );
}

/** `/settings` and a bare group path: the first page the person is offered. */
export function SettingsLanding({ group }: { readonly group?: SettingsGroupId }): ReactNode {
  const session = useSession();
  return <Navigate to={firstSettingsPath(session.user, group)} replace />;
}

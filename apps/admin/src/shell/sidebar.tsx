import { Box, Popover, Typography } from '@mui/material';
import { Layers, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { NavLink } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { useSession } from '../auth/session.tsx';
import { TicketViewsNav } from '../screens/tickets/views-nav.tsx';
import { BrandSwitcher } from './brand-switcher.tsx';
import { CountBadge } from './count-badge.tsx';
import { ADMIN_NAV, type NavItem, navFor, PRIMARY_NAV } from './nav-items.js';
import { NotificationBell } from './notification-bell.tsx';
import { RailTooltip } from './rail-tooltip.tsx';
import { useSidebarScroll } from './sidebar-scroll.js';
import { UserMenu } from './user-menu.tsx';

export const SIDEBAR_WIDTH = 220;
/** The collapsed icon rail of `Admin/Shell-SidebarCollapse`. */
export const RAIL_WIDTH = 56;

/** The column's state and its toggle. The drawer below 1024 px has neither. */
export interface SidebarCollapse {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

function NavItemLink({
  item,
  count,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly count?: number | undefined;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const Icon = item.icon;

  return (
    // NavLink puts `aria-current="page"` on the anchor itself when it matches.
    <NavLink
      to={item.path}
      end
      onClick={onNavigate}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      {({ isActive }) => (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            height: 36,
            paddingInline: 3,
            borderRadius: '6px',
            fontWeight: isActive ? 500 : 400,
            backgroundColor: isActive ? tokens['bg.muted'] : 'transparent',
            '&:hover': { backgroundColor: tokens['bg.muted'] },
          }}
        >
          <Icon size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{ flex: 1, fontWeight: 'inherit' }}
          >
            {t(item.labelKey)}
          </Typography>
          {count === undefined ? null : (
            <Typography component="span" variant="mono" sx={{ color: 'text.secondary' }}>
              {count}
            </Typography>
          )}
        </Box>
      )}
    </NavLink>
  );
}

/**
 * A destination on the collapsed rail: a 36 px icon link named by its label,
 * with the full count in the name ("Tickets · 38") and a badge drawn on the
 * icon, and the label in a Tooltip on hover and focus.
 */
function RailLink({
  item,
  count,
}: {
  readonly item: NavItem;
  readonly count?: number | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const Icon = item.icon;
  const label = t(item.labelKey);

  return (
    <RailTooltip title={label}>
      <NavLink
        to={item.path}
        end
        aria-label={count === undefined ? label : t('admin:nav.withCount', { label, count })}
        style={{ textDecoration: 'none', color: 'inherit', display: 'block', borderRadius: 6 }}
      >
        {({ isActive }) => (
          <Box
            sx={{
              position: 'relative',
              width: 36,
              height: 36,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '6px',
              backgroundColor: isActive ? tokens['bg.muted'] : 'transparent',
              '&:hover': { backgroundColor: tokens['bg.muted'] },
            }}
          >
            <Icon size={16} aria-hidden="true" />
            {count === undefined ? null : <CountBadge count={count} />}
          </Box>
        )}
      </NavLink>
    </RailTooltip>
  );
}

/** A 24 px hairline between the rail's groups, where the expanded column has captions. */
function RailDivider(): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="li"
      aria-hidden="true"
      sx={{ width: 24, height: '1px', marginBlock: 2, backgroundColor: tokens['border.default'] }}
    />
  );
}

/**
 * The Views group on the rail: one `Layers` icon that opens the same list the
 * column shows, in a popover at the rail's inline end.
 */
function RailViews(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const popoverId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const label = t('tickets:views.label');
  // MUI anchors by physical side, so the inline end is spelled per direction.
  const end = locale === 'ar' ? 'left' : 'right';
  const start = locale === 'ar' ? 'right' : 'left';
  const close = (): void => {
    setAnchor(null);
  };

  return (
    <>
      <RailTooltip title={label}>
        <Box
          component="button"
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={anchor !== null}
          aria-controls={anchor === null ? undefined : popoverId}
          onClick={(event) => {
            setAnchor(event.currentTarget);
          }}
          sx={{
            width: 36,
            height: 36,
            display: 'grid',
            placeItems: 'center',
            border: 0,
            borderRadius: '6px',
            color: 'inherit',
            cursor: 'pointer',
            backgroundColor: anchor === null ? 'transparent' : tokens['bg.muted'],
            '&:hover': { backgroundColor: tokens['bg.muted'] },
          }}
        >
          <Layers size={16} aria-hidden="true" />
        </Box>
      </RailTooltip>
      <Popover
        id={popoverId}
        open={anchor !== null}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: 'top', horizontal: end }}
        transformOrigin={{ vertical: 'top', horizontal: start }}
        slotProps={{
          paper: {
            role: 'dialog',
            'aria-label': label,
            sx: { width: SIDEBAR_WIDTH, padding: 2, marginInlineStart: 1 },
          },
        }}
      >
        <TicketViewsNav onNavigate={close} />
      </Popover>
    </>
  );
}

/**
 * Collapse and expand (`Admin/Shell-SidebarCollapse`): one button in both
 * states, so the DOM node and the focus on it survive the toggle. Expanded, a
 * 32 px row with its label and the ⌘\ hint; collapsed, a 36 px icon with the
 * label in a Tooltip. The icon is mirrored in Arabic, where the rail sits on
 * the right.
 *
 * The row prints `collapseShort`: in Arabic the full name does not fit beside
 * the Ctrl key caps. The accessible name stays the full one, which contains
 * the visible words (WCAG 2.5.3).
 */
function SidebarToggle({
  collapse,
  controls,
}: {
  readonly collapse: SidebarCollapse;
  readonly controls: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const { collapsed, onToggle } = collapse;
  const label = collapsed ? t('admin:nav.expand') : t('admin:nav.collapse');
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const modifier = isMac() ? '⌘' : t('admin:nav.ctrlKey');

  return (
    <RailTooltip title={collapsed ? label : ''}>
      <Box
        component="button"
        type="button"
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls={controls}
        aria-keyshortcuts={'Meta+\\ Control+\\'}
        onClick={onToggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          width: collapsed ? 36 : '100%',
          height: 32,
          paddingInline: collapsed ? 0 : 3,
          justifyContent: collapsed ? 'center' : 'flex-start',
          border: 0,
          borderRadius: '6px',
          backgroundColor: 'transparent',
          color: tokens['text.secondary'],
          font: 'inherit',
          fontSize: 12,
          cursor: 'pointer',
          '&:hover': { backgroundColor: tokens['bg.muted'] },
        }}
      >
        <Icon
          size={16}
          aria-hidden="true"
          style={{ flexShrink: 0, transform: locale === 'ar' ? 'scaleX(-1)' : undefined }}
        />
        {collapsed ? null : (
          <>
            <Box
              component="span"
              sx={{
                flex: 1,
                minWidth: 0,
                textAlign: 'start',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {t('admin:nav.collapseShort')}
            </Box>
            <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', gap: '2px' }}>
              {[modifier, '\\'].map((key) => (
                <Box
                  key={key}
                  component="kbd"
                  sx={{
                    fontFamily: 'var(--hd-font-mono, monospace)',
                    fontSize: 11,
                    paddingInline: '2px',
                    border: `1px solid ${tokens['border.strong']}`,
                    borderRadius: '4px',
                    backgroundColor: tokens['bg.surface'],
                    color: tokens['text.secondary'],
                  }}
                >
                  {key}
                </Box>
              ))}
            </Box>
          </>
        )}
      </Box>
    </RailTooltip>
  );
}

/**
 * The sidebar of DESIGN §6.5: brand switcher, the primary group, the "Admin"
 * group under its label, and the current user at the bottom. A permanent
 * column from 1024 px, which collapses to a 56 px icon rail
 * (`Admin/Shell-SidebarCollapse`), and a drawer below it.
 */
export function Sidebar({
  onNavigate,
  collapse,
}: {
  /** The drawer passes its close handler; the permanent column passes nothing. */
  readonly onNavigate?: (() => void) | undefined;
  /** The permanent column's collapse; the drawer passes none and is never a rail. */
  readonly collapse?: SidebarCollapse | undefined;
} = {}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const session = useSession();
  const sidebarId = useId();
  const counts = session.navCounts ?? {};
  const collapsed = collapse?.collapsed === true;
  const { navRef, contentRef, edges } = useSidebarScroll();
  // Chrome only: the api refuses the request whatever the sidebar draws.
  // "Staff and roles" is for the two roles that hold `staff:manage`; "System"
  // is install-wide and is offered to an install admin alone.
  const primaryNav = navFor(PRIMARY_NAV, session.user);
  const adminNav = navFor(ADMIN_NAV, session.user);

  return (
    <Box
      id={sidebarId}
      sx={{
        width: collapsed ? RAIL_WIDTH : SIDEBAR_WIDTH,
        height: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: collapsed ? 'center' : 'stretch',
        gap: 3,
        paddingBlock: 3,
        paddingInline: collapsed ? 2 : 3,
        boxSizing: 'border-box',
        overflowX: 'hidden',
        backgroundColor: tokens['bg.canvas'],
        borderInlineEnd: `1px solid ${tokens['border.default']}`,
        transition: 'width 200ms ease-out',
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      {/* The brand row: the switcher, and the bell at its inline end (M3-07). */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: collapsed ? 'column' : 'row',
          alignItems: 'center',
          gap: 1,
          flexShrink: 0,
        }}
      >
        <Box sx={{ flex: collapsed ? 'none' : 1, minWidth: 0 }}>
          <BrandSwitcher variant={collapsed ? 'mark' : 'full'} />
        </Box>
        <NotificationBell />
      </Box>

      {/* Scrolls on its own: a brand's views (M1-05) can make the groups taller
          than the window, and the Admin group must stay reachable under them. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          alignSelf: 'stretch',
          marginInlineStart: collapsed ? -2 : -1,
          marginInlineEnd: collapsed ? -2 : -3,
          position: 'relative',
          '&::before, &::after': {
            content: '""',
            position: 'absolute',
            insetInline: 0,
            height: '1px',
            backgroundColor: tokens['border.default'],
            pointerEvents: 'none',
            zIndex: 1,
          },
          '&::before': { insetBlockStart: 0, opacity: edges.top ? 1 : 0 },
          '&::after': { insetBlockEnd: 0, opacity: edges.bottom ? 1 : 0 },
        }}
      >
        <Box
          ref={navRef}
          component="nav"
          aria-label={t('admin:nav.label')}
          data-scroll-top={edges.top}
          data-scroll-bottom={edges.bottom}
          onFocus={(event) => {
            if (event.currentTarget.contains(event.target)) {
              event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
          }}
          sx={{
            height: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            scrollbarGutter: 'stable',
            scrollPaddingBlock: '4px',
            // Standard scrollbar properties override WebKit's width and button rules.
            '@supports not selector(::-webkit-scrollbar)': {
              scrollbarWidth: 'thin',
              scrollbarColor: `${collapsed ? 'transparent' : tokens['border.strong']} transparent`,
              '&:hover, &:focus-within': {
                scrollbarColor: `${tokens['border.strong']} transparent`,
              },
            },
            '& a:focus-visible, & button:focus-visible': {
              outlineOffset: collapsed ? '-2px' : undefined,
            },
            '&::-webkit-scrollbar': { width: '4px', height: 0 },
            '&::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: collapsed ? 'transparent' : tokens['border.strong'],
              borderRadius: '4px',
            },
            '&:hover::-webkit-scrollbar-thumb, &:focus-within::-webkit-scrollbar-thumb': {
              backgroundColor: tokens['border.strong'],
            },
            '&::-webkit-scrollbar-button': { display: 'none', width: 0, height: 0 },
            // Stable gutters keep the icons still while scrollbars are hidden during width changes.
            animation: `${collapsed ? 'rail-scroll' : 'column-scroll'} 200ms step-end`,
            '@keyframes rail-scroll': { from: { overflowY: 'hidden' }, to: { overflowY: 'auto' } },
            '@keyframes column-scroll': {
              from: { overflowY: 'hidden' },
              to: { overflowY: 'auto' },
            },
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          }}
        >
          <Box
            ref={contentRef}
            sx={{
              paddingBlock: 1,
              width: collapsed ? 36 : 'auto',
              // Use the full rail's centre, independent of the reserved scrollbar gutter.
              marginInlineStart: collapsed ? `${(RAIL_WIDTH - 1 - 36) / 2}px` : 0,
              paddingInlineStart: collapsed ? 0 : 1,
              paddingInlineEnd: collapsed ? 0 : 2,
            }}
          >
            {collapsed ? (
              <Box
                component="ul"
                sx={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 1,
                }}
              >
                {primaryNav.map((item) => (
                  <Box component="li" key={item.key}>
                    <RailLink item={item} count={counts[item.key]} />
                  </Box>
                ))}
                <RailDivider />
                <Box component="li">
                  <RailViews />
                </Box>
                <RailDivider />
                {adminNav.map((item) => (
                  <Box component="li" key={item.key}>
                    <RailLink item={item} count={counts[item.key]} />
                  </Box>
                ))}
              </Box>
            ) : (
              <>
                <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {primaryNav.map((item) => (
                    <Box component="li" key={item.key}>
                      <NavItemLink item={item} count={counts[item.key]} onNavigate={onNavigate} />
                    </Box>
                  ))}
                </Box>

                {/* DESIGN §6.5: the "Views" group sits under the primary nav, because
                it is a set of ways into the destination above it (M1-15). */}
                <TicketViewsNav onNavigate={onNavigate} />

                <Typography
                  component="p"
                  variant="caption"
                  sx={{
                    color: 'text.secondary',
                    paddingInline: 3,
                    marginBlock: '16px 4px',
                    fontSize: 11,
                    // DESIGN §3.2: uppercase section labels are regular case in Arabic.
                    textTransform: locale === 'ar' ? 'none' : 'uppercase',
                    letterSpacing: locale === 'ar' ? 0 : '0.06em',
                  }}
                >
                  {t('admin:nav.adminGroup')}
                </Typography>

                <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {adminNav.map((item) => (
                    <Box component="li" key={item.key}>
                      <NavItemLink item={item} count={counts[item.key]} onNavigate={onNavigate} />
                    </Box>
                  ))}
                </Box>
              </>
            )}
          </Box>
        </Box>
      </Box>

      <Box
        sx={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: collapsed ? 'center' : 'stretch',
          alignSelf: 'stretch',
          gap: 1,
          paddingBlockStart: 2,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
        }}
      >
        {collapse === undefined ? null : <SidebarToggle collapse={collapse} controls={sidebarId} />}
        <UserMenu variant={collapsed ? 'avatar' : 'full'} />
      </Box>
    </Box>
  );
}

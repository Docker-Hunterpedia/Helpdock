import { monoFontStyle } from '@helpdock/ui';
import { Box } from '@mui/material';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { useSession } from '../auth/session.tsx';
import { KeyCombo } from '../keyboard/key-combo.tsx';
import { useAriaKeyShortcuts } from '../keyboard/keyboard-provider.tsx';
import { isMac } from '../keyboard/keys.js';
import { shortcutById } from '../keyboard/registry.js';
import { usePalette } from '../palette/palette-provider.tsx';
import { BrandSwitcher } from './brand-switcher.tsx';
import { NotificationBell } from './notification-bell.tsx';
import { RailTooltip } from './rail-tooltip.tsx';
import { SetupChecklistEntry } from './setup-checklist.tsx';
import { useSidebarScroll } from './sidebar-scroll.js';
import { sectionAt, sectionsFor } from './sidebar-sections.js';
import { RailSection, SidebarTree } from './sidebar-tree.tsx';
import { UserMenu } from './user-menu.tsx';

export const SIDEBAR_WIDTH = 220;
/** The collapsed icon rail of `Admin/Shell-SidebarCollapse`. */
export const RAIL_WIDTH = 56;

/** The column's state and its toggle. The drawer below 1024 px has neither. */
export interface SidebarCollapse {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

/**
 * The sidebar's Search (`Admin/Settings-Shell`, M14-05): a 32 px field-shaped
 * button under the brand row that opens the command palette, with the `⌘K`
 * caps at its inline end. Collapsed it is a 36 px icon with a Tooltip, like the
 * rail's other controls. The caps are `aria-hidden`; the shortcut is in
 * `aria-keyshortcuts`.
 */
function SidebarSearch({
  collapsed,
  onNavigate,
}: {
  readonly collapsed: boolean;
  readonly onNavigate?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const palette = usePalette();
  const keyShortcuts = useAriaKeyShortcuts('general.palette');
  const label = t('admin:palette.sidebarSearch');

  return (
    <RailTooltip title={collapsed ? label : ''}>
      <Box
        component="button"
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-keyshortcuts={keyShortcuts}
        onClick={() => {
          onNavigate?.();
          palette.open();
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexShrink: 0,
          boxSizing: 'border-box',
          width: collapsed ? 36 : '100%',
          height: collapsed ? 36 : 32,
          paddingInline: collapsed ? 0 : 3,
          justifyContent: collapsed ? 'center' : 'flex-start',
          border: collapsed ? 0 : `1px solid ${tokens['border.strong']}`,
          borderRadius: '6px',
          backgroundColor: collapsed ? 'transparent' : tokens['bg.surface'],
          color: tokens['text.secondary'],
          font: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
          '&:hover': { backgroundColor: tokens['bg.muted'] },
          '&:focus-visible': { outline: `2px solid ${tokens['border.focus']}`, outlineOffset: -2 },
        }}
      >
        <Search size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
        {collapsed ? null : (
          <>
            <Box component="span" sx={{ flex: 1, textAlign: 'start' }}>
              {label}
            </Box>
            <Box component="span" aria-hidden="true">
              <KeyCombo keys={shortcutById('general.palette').keys} />
            </Box>
          </>
        )}
      </Box>
    </RailTooltip>
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
  const keyShortcuts = useAriaKeyShortcuts('general.sidebar');

  return (
    <RailTooltip title={collapsed ? label : ''}>
      <Box
        component="button"
        type="button"
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls={controls}
        aria-keyshortcuts={keyShortcuts}
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
                    ...monoFontStyle,
                    fontSize: 12,
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
  const tokens = useSemanticTokens();
  const session = useSession();
  const sidebarId = useId();
  const counts = session.navCounts ?? {};
  const collapsed = collapse?.collapsed === true;
  const { navRef, contentRef, edges } = useSidebarScroll();
  // Chrome only: the api refuses the request whatever the sidebar draws.
  // "Staff and roles" is for the two roles that hold `staff:manage`; "System"
  // is install-wide and is offered to an install admin alone.
  // One tree (`Admin/UX-Fixes-2026-11`): Tickets, Contacts, Help center, Reports
  // and Settings, each opening onto its own pages.
  const { pathname } = useLocation();
  const sections = sectionsFor(session.user);

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

      <SidebarSearch collapsed={collapsed} onNavigate={onNavigate} />

      {/* Scrolls on its own: a brand's views (M1-05) can make the groups taller
          than the window, and the Admin group must stay reachable under them. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          alignSelf: 'stretch',
          marginInlineStart: -2,
          marginInlineEnd: collapsed ? -2 : -3,
          position: 'relative',
          '&::before, &::after': {
            content: '""',
            position: 'absolute',
            insetInlineStart: collapsed ? `${(RAIL_WIDTH - 1 - 36) / 2}px` : '8px',
            width: collapsed ? 36 : SIDEBAR_WIDTH - 1 - 24,
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
              scrollbarColor: `${tokens['border.strong']} transparent`,
            },
            '& a:focus-visible, & button:focus-visible': {
              outline: collapsed ? `2px solid ${tokens['border.focus']}` : undefined,
              outlineOffset: collapsed ? '-2px' : undefined,
            },
            '&::-webkit-scrollbar': { width: '4px', height: 0 },
            '&::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: tokens['border.strong'],
              borderRadius: '4px',
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
              width: collapsed ? 36 : SIDEBAR_WIDTH - 1 - 8,
              maxWidth: '100%',
              // Use the full rail's centre, independent of the reserved scrollbar gutter.
              marginInlineStart: collapsed ? `${(RAIL_WIDTH - 1 - 36) / 2}px` : 0,
              paddingInlineStart: collapsed ? 0 : 2,
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
                {sections.map((section) => (
                  <Box component="li" key={section.key}>
                    <RailSection
                      section={section}
                      count={counts[section.nav]}
                      current={sectionAt(pathname) === section.key}
                    />
                  </Box>
                ))}
              </Box>
            ) : (
              <SidebarTree onNavigate={onNavigate} />
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
        {collapsed ? null : <SetupChecklistEntry />}
        {collapse === undefined ? null : <SidebarToggle collapse={collapse} controls={sidebarId} />}
        <UserMenu variant={collapsed ? 'avatar' : 'full'} />
      </Box>
    </Box>
  );
}

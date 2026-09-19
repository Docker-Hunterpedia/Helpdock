import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';
import { useSession } from '../auth/session.tsx';
import { BrandSwitcher } from './brand-switcher.tsx';
import { ADMIN_NAV, type NavItem, PRIMARY_NAV } from './nav-items.js';
import { UserMenu } from './user-menu.tsx';

export const SIDEBAR_WIDTH = 220;

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
 * The 220 px sidebar of DESIGN §6.5: brand switcher, the primary group, the
 * "Admin" group under its label, and the current user at the bottom. Rendered
 * inside a permanent column above 1024 px and inside a drawer below it.
 */
export function Sidebar({
  onNavigate,
}: {
  /** The drawer passes its close handler; the permanent column passes nothing. */
  readonly onNavigate?: (() => void) | undefined;
} = {}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const session = useSession();
  const counts = session.navCounts ?? {};

  return (
    <Box
      sx={{
        width: SIDEBAR_WIDTH,
        height: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: 3,
        backgroundColor: tokens['bg.canvas'],
        borderInlineEnd: `1px solid ${tokens['border.default']}`,
      }}
    >
      <BrandSwitcher />

      <Box component="nav" aria-label={t('admin:nav.label')} sx={{ flex: 1, minHeight: 0 }}>
        <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {PRIMARY_NAV.map((item) => (
            <Box component="li" key={item.key}>
              <NavItemLink item={item} count={counts[item.key]} onNavigate={onNavigate} />
            </Box>
          ))}
        </Box>

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
          {/* The System page is install-wide — schema, queues, the database
              role — so only an install admin is offered it. A brand admin who
              reaches the path anyway is refused by the api, not by the nav. */}
          {ADMIN_NAV.filter((item) => item.key !== 'system' || session.user.installAdmin).map(
            (item) => (
              <Box component="li" key={item.key}>
                <NavItemLink item={item} count={counts[item.key]} onNavigate={onNavigate} />
              </Box>
            ),
          )}
        </Box>
      </Box>

      <UserMenu />
    </Box>
  );
}

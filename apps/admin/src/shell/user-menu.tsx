import { Avatar, Box, Divider, ListItemIcon, Menu, MenuItem, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { Check, Languages, LogOut, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { otherLocale, useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { ROUTES } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { useAuthApi, useSession, useSetSession } from '../auth/session.tsx';
import { SidebarMenuTrigger } from './sidebar-menu-trigger.tsx';

const THEME_OPTIONS = [
  { preference: 'light', labelKey: 'admin:theme.light', icon: Sun },
  { preference: 'dark', labelKey: 'admin:theme.dark', icon: Moon },
  { preference: 'auto', labelKey: 'admin:theme.auto', icon: Monitor },
] as const;

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join('')
    .toUpperCase();

/**
 * The current user at the bottom of the sidebar (DESIGN §6.5) and the menu it
 * opens: language, theme and sign out. Install admins are labelled as such
 * rather than by their brand role.
 */
export function UserMenu(): ReactNode {
  const t = useT();
  const session = useSession();
  const api = useAuthApi();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const tokens = useSemanticTokens();
  const { locale, setLocale, themePreference, setThemePreference } = usePreferences();
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const other = otherLocale(locale);
  const menuLabel = t('admin:currentUser.menuLabel', { name: session.user.name });

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    // Settled, not success: a sign-out the server did not hear about still has
    // to clear this browser, or a failed request leaves the session on screen.
    onSettled: () => {
      setSession(null);
      void navigate(ROUTES.signIn, { replace: true });
    },
  });

  const close = (): void => {
    setAnchor(null);
  };

  return (
    <>
      <SidebarMenuTrigger
        label={menuLabel}
        menuId={menuId}
        open={anchor !== null}
        onOpen={setAnchor}
      >
        <Avatar
          aria-hidden="true"
          sx={{
            width: 28,
            height: 28,
            fontSize: 12,
            fontWeight: 600,
            backgroundColor: tokens['action.primary.tint'],
            color: tokens['text.primary'],
          }}
        >
          {initials(session.user.name)}
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="bodyStrong" noWrap component="span" sx={{ display: 'block' }}>
            {session.user.name}
          </Typography>
          <Typography
            variant="caption"
            noWrap
            component="span"
            sx={{ display: 'block', color: 'text.secondary' }}
          >
            {session.user.installAdmin
              ? t('admin:currentUser.installAdmin')
              : t(`staff:roles.${session.user.role}`)}
          </Typography>
        </Box>
      </SidebarMenuTrigger>

      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={close}
        slotProps={{ list: { 'aria-label': menuLabel } }}
      >
        <MenuItem
          onClick={() => {
            close();
            void navigate(ROUTES.security);
          }}
        >
          <ListItemIcon>
            <ShieldCheck size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('me:security.title')}
        </MenuItem>

        <Divider />

        <MenuItem
          onClick={() => {
            setLocale(other);
            close();
          }}
        >
          <ListItemIcon>
            <Languages size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('common:language.switchTo', { language: t(`common:language.${other}`) })}
        </MenuItem>

        <Divider />

        {THEME_OPTIONS.map(({ preference, labelKey, icon: Icon }) => (
          <MenuItem
            key={preference}
            role="menuitemradio"
            aria-checked={themePreference === preference}
            onClick={() => {
              setThemePreference(preference);
              close();
            }}
          >
            <ListItemIcon>
              {themePreference === preference ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Icon size={16} aria-hidden="true" />
              )}
            </ListItemIcon>
            {t(labelKey)}
          </MenuItem>
        ))}

        <Divider />

        <MenuItem
          onClick={() => {
            close();
            signOut.mutate();
          }}
        >
          <ListItemIcon>
            <LogOut size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('admin:currentUser.signOut')}
        </MenuItem>
      </Menu>
    </>
  );
}

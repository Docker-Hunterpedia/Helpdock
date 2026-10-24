import { Box, Typography } from '@mui/material';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { ROUTES } from '../app/route-paths.js';
import { useSettingsHeader } from './settings-header.js';

/**
 * DESIGN §6.5: h1 plus an optional caption, with the primary action at the
 * inline end. Inside the Settings area (M14-21) a breadcrumb sits above the h1
 * and the h1 is the navigation entry's name, so the page reads the same as the
 * link that opened it.
 */
export function PageHeader({
  title,
  caption,
  action,
}: {
  readonly title: string;
  readonly caption?: string | undefined;
  readonly action?: ReactNode | undefined;
}): ReactNode {
  const settings = useSettingsHeader();

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 6,
        marginBlockEnd: 8,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <SettingsBreadcrumb />
        <Typography variant="h1" component="h1">
          {settings?.title ?? title}
        </Typography>
        {caption ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {caption}
          </Typography>
        ) : null}
      </Box>
      {action}
    </Box>
  );
}

/**
 * `Settings › Inbox` above a page's h1, as a breadcrumb landmark; nothing
 * outside the Settings area. "Settings" links to the area (which opens its
 * first page), the group is the current level, and the separator is a chevron
 * that turns in Arabic.
 */
export function SettingsBreadcrumb(): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const settings = useSettingsHeader();
  if (settings === null) {
    return null;
  }

  return (
    <Box component="nav" aria-label={t('admin:settings.breadcrumb')}>
      <Box
        component="ol"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          listStyle: 'none',
          margin: 0,
          padding: 0,
          fontSize: 12,
          color: 'text.secondary',
        }}
      >
        {settings.crumbs.map((crumb, index) => {
          const last = index === settings.crumbs.length - 1;
          return (
            <Box
              component="li"
              key={crumb}
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
            >
              {last ? (
                <span aria-current="page">{crumb}</span>
              ) : (
                <Link to={ROUTES.settings} style={{ color: 'inherit' }}>
                  {crumb}
                </Link>
              )}
              {last ? null : (
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  style={{ transform: locale === 'ar' ? 'scaleX(-1)' : undefined }}
                />
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

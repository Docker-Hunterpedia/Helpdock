import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
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

/** `Settings › Inbox` above a page's h1; nothing outside the Settings area. */
export function SettingsBreadcrumb(): ReactNode {
  const settings = useSettingsHeader();

  return settings === null ? null : (
    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
      {settings.crumbs.join(' › ')}
    </Typography>
  );
}

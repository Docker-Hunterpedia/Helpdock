import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * DESIGN §6.5: h1 plus an optional caption, with the primary action at the
 * inline end. No breadcrumbs in admin — the sidebar is the map.
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
        <Typography variant="h1" component="h1">
          {title}
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

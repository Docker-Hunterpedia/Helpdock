import { Box, Paper, Typography } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * One area of the security page, in the `Admin/Settings` card shape: a
 * bordered `Paper` on `bg.surface` with its own title and caption, then the
 * area's fields.
 */
export function AccountCard({
  title,
  caption,
  children,
}: {
  readonly title: string;
  readonly caption: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const titleId = useId();

  return (
    <Paper
      elevation={0}
      component="section"
      aria-labelledby={titleId}
      sx={{
        padding: 6,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography id={titleId} variant="h3" component="h2">
          {title}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {caption}
        </Typography>
      </Box>
      {children}
    </Paper>
  );
}

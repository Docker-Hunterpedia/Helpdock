import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The small explanatory cards under a Channels list — "Replies go out once
 * per brand", the health legend, "How updates arrive": a 13 px heading and
 * secondary text, on the surface with a hairline edge.
 */
export function NoteCard({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        paddingBlock: '14px',
        paddingInline: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontSize: 13,
        lineHeight: '18px',
        color: 'text.secondary',
      }}
    >
      <Typography variant="bodyStrong" component="h3" sx={{ fontSize: 13, color: 'text.primary' }}>
        {heading}
      </Typography>
      <Box>{children}</Box>
    </Box>
  );
}

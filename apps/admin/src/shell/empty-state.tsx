import { Box, Typography } from '@mui/material';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.3: a 24 px icon in the muted neutral, an h3 and one sentence.
 * Never an illustration, and no action while there is nothing to act on.
 */
export function EmptyState({
  icon: Icon,
  heading,
  body,
}: {
  readonly icon: LucideIcon;
  readonly heading: string;
  readonly body: string;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        textAlign: 'center',
        paddingBlock: 16,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Icon size={24} aria-hidden="true" color={tokens['text.disabled']} />
      <Typography variant="h3" component="h2">
        {heading}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 420 }}>
        {body}
      </Typography>
    </Box>
  );
}

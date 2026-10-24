import { Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.2 Label: a 12 px caption on `bg.muted` in `text.secondary`, radius
 * md, no dot and no border. A fact about a row ("built-in", "hidden", "pinned"),
 * never a status, so it never takes a status colour.
 */
export function Label({ children }: { readonly children: ReactNode }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Typography
      component="span"
      variant="caption"
      sx={{
        paddingInline: 2,
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        color: tokens['text.secondary'],
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Typography>
  );
}

import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.2 Kbd: one key cap, as `<kbd>`. 20 px high and at least 20 wide,
 * radius sm, a 1 px `border.strong` edge that is 2 px at the block end so the
 * cap reads as a key, `bg.surface`, mono 12/16 in `text.secondary`. Used by
 * the `?` sheet and the `g` chip (M14-01); the palette, tooltips and empty
 * states take it up in M14-05 and M14-06.
 */
export function Kbd({ children }: { readonly children: ReactNode }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="kbd"
      sx={{
        typography: 'mono',
        boxSizing: 'border-box',
        minWidth: 20,
        height: 20,
        paddingInline: '4px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        lineHeight: '16px',
        borderRadius: '4px',
        border: `1px solid ${tokens['border.strong']}`,
        borderBlockEndWidth: 2,
        backgroundColor: tokens['bg.surface'],
        color: tokens['text.secondary'],
      }}
    >
      {children}
    </Box>
  );
}

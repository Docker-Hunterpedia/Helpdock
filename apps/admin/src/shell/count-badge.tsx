import { Box, useTheme } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/** A two-digit badge at most: past 99 the exact number stops being information. */
const badgeText = (count: number): string => (count > 99 ? '99+' : String(count));

/**
 * The NotificationBell's count (DESIGN §6.2), also drawn on a rail icon of the
 * collapsed sidebar: an 18 px `full`-radius badge in `action.primary` at the
 * top inline-end corner of its 32 or 36 px button, mono 11. It is `aria-hidden`:
 * the button's own name carries the full count.
 */
export function CountBadge({ count }: { readonly count: number }): ReactNode {
  const theme = useTheme();
  const tokens = useSemanticTokens();

  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        position: 'absolute',
        insetBlockStart: 0,
        insetInlineEnd: 0,
        minWidth: 18,
        height: 18,
        paddingInline: 1,
        boxSizing: 'border-box',
        borderRadius: '999px',
        backgroundColor: tokens['action.primary'],
        color: tokens['action.primary.text'],
        fontFamily: theme.typography.mono.fontFamily,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: '18px',
        textAlign: 'center',
      }}
    >
      {badgeText(count)}
    </Box>
  );
}

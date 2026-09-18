import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * The teal square with the brand's initial, from the artboards `Admin/Login`
 * and the sidebar header. Decorative: the brand name always sits beside it as
 * text, so the square is hidden from assistive technology.
 */
export function BrandMark({
  initial,
  size = 28,
}: {
  readonly initial: string;
  readonly size?: number;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      aria-hidden="true"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        borderRadius: '6px',
        backgroundColor: tokens['action.primary'],
        color: tokens['action.primary.text'],
        fontSize: Math.round(size * 0.5),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {initial}
    </Box>
  );
}

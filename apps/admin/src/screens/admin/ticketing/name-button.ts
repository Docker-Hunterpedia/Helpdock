import type { SxProps, Theme } from '@mui/material';

/**
 * The name in a table row that opens the row's editor. A text Button centres and
 * wraps by default, which pulls a two-word name onto two centred lines; a name
 * is start-aligned on one line and cut with an ellipsis when it cannot fit.
 */
export const nameButtonSx: SxProps<Theme> = {
  justifyContent: 'flex-start',
  textAlign: 'start',
  paddingInline: 0,
  minWidth: 0,
  maxWidth: '100%',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: 'inline-block',
  lineHeight: 'inherit',
};

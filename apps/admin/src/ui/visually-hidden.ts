/**
 * Read by a screen reader, drawn as nothing. One copy for the whole admin: the
 * sizes are strings on purpose, because MUI reads a bare `1` as `100%`. A copy
 * with `width: 1` made a span in the composer as wide as the viewport and gave
 * the ticket view a horizontal scrollbar in both directions.
 */
export const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

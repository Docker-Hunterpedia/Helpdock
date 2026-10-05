import { Box, Typography } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.3 MetricTile (M8-04, M8-05, M8-07): a label, a headline figure in
 * mono 24/32 500, and one caption that compares or explains it in words. The
 * direction of a change is said in the caption, never by an arrow or a hue.
 */
export function MetricTile({
  label,
  figure,
  caption,
  badge,
}: {
  readonly label: string;
  readonly figure: string;
  readonly caption: string;
  /** A state at the label's inline end ("Activated", "3 brands"). */
  readonly badge?: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const labelId = useId();

  return (
    <Box
      component="section"
      aria-labelledby={labelId}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        paddingBlock: 3,
        paddingInline: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Typography
          id={labelId}
          variant="caption"
          component="h2"
          sx={{ color: 'text.secondary', margin: 0 }}
        >
          {label}
        </Typography>
        {badge}
      </Box>
      <Typography
        variant="mono"
        component="p"
        sx={{ fontSize: 24, lineHeight: '32px', fontWeight: 500 }}
      >
        {/* Latin and left to right in both languages (DESIGN §7), but placed
            at the inline start of the page. */}
        <bdi dir="ltr">{figure}</bdi>
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
        {caption}
      </Typography>
    </Box>
  );
}

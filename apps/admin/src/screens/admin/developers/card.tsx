import type { SemanticTokens } from '@helpdock/ui';
import { Box, Typography } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The radius lg card every panel of the Developers page sits in: `bg.surface`,
 * a `border.default` edge, and an optional header of h2 over a caption with
 * one control at its inline end (the "Show revoked" box, the log's filter).
 */
export function Card({
  labelledBy,
  children,
}: {
  readonly labelledBy?: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="section"
      aria-labelledby={labelledBy}
      sx={{
        minWidth: 0,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      {children}
    </Box>
  );
}

export function CardHeader({
  heading,
  caption,
  action,
  headingId,
  small = false,
}: {
  readonly heading: ReactNode;
  readonly caption?: ReactNode;
  readonly action?: ReactNode;
  /** When the card's `aria-labelledby` points here. */
  readonly headingId?: string;
  /** The DeliveryLog's 14/600 heading rather than a card's 16. */
  readonly small?: boolean;
}): ReactNode {
  const fallbackId = useId();

  return (
    <Box
      sx={{
        paddingBlock: 3,
        paddingInline: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        flexWrap: 'wrap',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
        <Typography
          id={headingId ?? fallbackId}
          variant="h3"
          component="h2"
          sx={{ fontSize: small ? 14 : 16 }}
        >
          {heading}
        </Typography>
        {caption === undefined ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {caption}
          </Typography>
        )}
      </Box>
      {action === undefined ? null : <Box sx={{ marginInlineStart: 'auto' }}>{action}</Box>}
    </Box>
  );
}

/** §6.5 Tables: the header row's cells, 12/500 in `text.secondary`. */
export const headCellSx = (tokens: SemanticTokens) =>
  ({
    fontSize: 12,
    fontWeight: 500,
    color: tokens['text.secondary'],
    paddingBlock: 0,
    whiteSpace: 'nowrap',
  }) as const;

import { Box, Typography } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The bordered radius-10 surface every panel on this page sits on (DESIGN §4,
 * §6.5). Not a new component in DESIGN §6: it is the card anatomy the empty
 * state and the details panel already use, extracted so the four health cards
 * and the three side panels cannot drift from each other.
 */
export function Card({
  title,
  action,
  children,
  padding = 4,
}: {
  readonly title?: string | undefined;
  readonly action?: ReactNode | undefined;
  readonly children: ReactNode;
  /** Spacing scale steps. The health cards use 14/16 px, the panels 16 px. */
  readonly padding?: number;
}): ReactNode {
  const tokens = useSemanticTokens();
  const headingId = useId();

  return (
    <Box
      component="section"
      // A `section` is only a landmark once it has a name, and the name is the
      // heading already on screen rather than a second copy of it.
      {...(title === undefined ? {} : { 'aria-labelledby': headingId })}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      {title === undefined ? null : (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 3,
            padding,
            paddingBlockEnd: 0,
          }}
        >
          <Typography variant="h3" component="h2" id={headingId}>
            {title}
          </Typography>
          {action}
        </Box>
      )}
      <Box sx={{ padding }}>{children}</Box>
    </Box>
  );
}

import { Box, Typography } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useSemanticTokens } from '../../../../app/tokens.js';

/**
 * One section of the bot form (`Admin/Channels-Telegram` panel 2): a 16 px
 * heading and its caption over the fields, separated from the next section by
 * a hairline, all inside the one form card.
 */
export function FormSection({
  heading,
  caption,
  children,
}: {
  readonly heading: string;
  readonly caption: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const headingId = useId();

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        paddingBlock: 5,
        paddingInline: 5,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderBlockStart: `1px solid ${tokens['border.default']}`,
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
          {heading}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
          {caption}
        </Typography>
      </Box>
      {children}
    </Box>
  );
}

/** The bordered card on the surface that the form and the side cards are drawn in. */
export function Card({
  label,
  tone = 'default',
  children,
}: {
  readonly label?: string;
  readonly tone?: 'default' | 'danger';
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      {...(label === undefined ? {} : { component: 'section', 'aria-label': label })}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tone === 'danger' ? tokens['status.danger'] : tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        minWidth: 0,
      }}
    >
      {children}
    </Box>
  );
}

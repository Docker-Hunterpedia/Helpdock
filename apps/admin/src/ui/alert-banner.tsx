import { Box, Typography } from '@mui/material';
import { Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

export type AlertTone = 'danger' | 'warning' | 'info';

/**
 * DESIGN §6.4 Banner: status tint, border, icon, text. The icon carries the
 * tone alongside the colour so nothing depends on colour alone (DESIGN §10),
 * and `role="alert"` announces the message the moment it appears.
 *
 * `warning` (M3-03) is a standing state rather than an event — the depth guard
 * stopped a loop today — so it is a `status`, read when reached, not announced
 * over whatever the person was doing.
 */
export function AlertBanner({
  tone,
  children,
}: {
  readonly tone: AlertTone;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const Icon = tone === 'info' ? Info : TriangleAlert;
  const palette = {
    background: tokens[`status.${tone}.tint`],
    border: tokens[`status.${tone}`],
    text: tokens[`status.${tone}.text`],
  };

  return (
    <Box
      role={tone === 'warning' ? 'status' : 'alert'}
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        padding: '10px 12px',
        borderRadius: '6px',
        backgroundColor: palette.background,
        border: `1px solid ${palette.border}`,
        color: palette.text,
      }}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
      <Typography variant="body2" sx={{ color: 'inherit' }}>
        {children}
      </Typography>
    </Box>
  );
}

import { Box, Typography } from '@mui/material';
import { Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

export type AlertTone = 'danger' | 'info';

/**
 * DESIGN §6.4 Banner: status tint, border, icon, text. The icon carries the
 * tone alongside the colour so nothing depends on colour alone (DESIGN §10),
 * and `role="alert"` announces the message the moment it appears.
 */
export function AlertBanner({
  tone,
  children,
}: {
  readonly tone: AlertTone;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const Icon = tone === 'danger' ? TriangleAlert : Info;
  const palette =
    tone === 'danger'
      ? {
          background: tokens['status.danger.tint'],
          border: tokens['status.danger'],
          text: tokens['status.danger.text'],
        }
      : {
          background: tokens['status.info.tint'],
          border: tokens['status.info'],
          text: tokens['status.info.text'],
        };

  return (
    <Box
      role="alert"
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

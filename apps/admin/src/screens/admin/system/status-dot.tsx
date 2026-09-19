import type { ComponentStatus } from '@helpdock/schemas';
import type { StatusName } from '@helpdock/ui';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The 6 px dot of DESIGN §6.2, in the status hues of §2.2, with its meaning
 * written beside it in words.
 *
 * The word is not decoration. DESIGN §10 requires that nothing depend on colour
 * alone, and "Degraded" is what a reader who cannot tell amber from green needs
 * in order to read the card at all.
 */

const DOT_SIZE = 6;

/** The three states the api reports, mapped to the hues DESIGN §2.1 names. */
const HUE: Record<ComponentStatus, StatusName> = {
  ok: 'success',
  warning: 'warning',
  error: 'danger',
};

export function StatusDot({ status }: { readonly status: ComponentStatus }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        width: DOT_SIZE,
        height: DOT_SIZE,
        borderRadius: '999px',
        flexShrink: 0,
        backgroundColor: tokens[`status.${HUE[status]}`],
      }}
    />
  );
}

export function StatusLabel({
  status,
  label,
}: {
  readonly status: ComponentStatus;
  readonly label: string;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <StatusDot status={status} />
      <Typography variant="bodyStrong" component="span">
        {label}
      </Typography>
    </Box>
  );
}

/** The text hue for a caption that is itself the warning or the failure. */
export const captionColor = (
  status: ComponentStatus,
  tokens: ReturnType<typeof useSemanticTokens>,
): string => (status === 'ok' ? tokens['text.secondary'] : tokens[`status.${HUE[status]}.text`]);

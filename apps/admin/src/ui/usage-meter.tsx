import { Box, Typography } from '@mui/material';
import { CircleAlert, OctagonX } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

export type UsageLevel = 'ok' | 'warning' | 'exceeded';

/** The level DESIGN §6.2 colours a share by: the budget alert at 80 %, the hard stop at 100 %. */
export const usageLevelOf = (share: number): UsageLevel =>
  share >= 1 ? 'exceeded' : share >= 0.8 ? 'warning' : 'ok';

/**
 * DESIGN §6.2 UsageMeter (M7-08, M7-10; `Admin/AI-Assistant` Budget): a 4 px
 * track filled to the share used, a label and figure above it and a caption
 * under it that says the share in words — so the level never rests on the
 * colour alone. The bar is a `progressbar` named after its period.
 */
export function UsageMeter({
  label,
  figure,
  share,
  caption,
  progressLabel,
}: {
  readonly label: string;
  /** "$1.20 of $5.00", already formatted. */
  readonly figure: ReactNode;
  /** 0 to 1; above 1 is drawn full. Null when there is no limit to measure against. */
  readonly share: number | null;
  readonly caption: string;
  /** "Monthly spend 100 %". */
  readonly progressLabel: string;
}): ReactNode {
  const tokens = useSemanticTokens();
  const level = share === null ? 'ok' : usageLevelOf(share);
  const fill = {
    ok: tokens['action.primary'],
    warning: tokens['status.warning'],
    exceeded: tokens['status.danger'],
  }[level];
  const captionColour = {
    ok: 'text.secondary',
    warning: tokens['status.warning.text'],
    exceeded: tokens['status.danger.text'],
  }[level];
  const Icon = level === 'exceeded' ? OctagonX : level === 'warning' ? CircleAlert : null;
  const percent = share === null ? 0 : Math.min(100, Math.round(share * 100));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box
        sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{label}</Typography>
        <Typography variant="mono" component="span" dir="ltr" sx={{ fontSize: 13 }}>
          {figure}
        </Typography>
      </Box>
      <Box
        role="progressbar"
        aria-label={progressLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        sx={{
          height: 4,
          borderRadius: '999px',
          backgroundColor: tokens['border.default'],
          overflow: 'hidden',
        }}
      >
        <Box sx={{ height: '100%', width: `${String(percent)}%`, backgroundColor: fill }} />
      </Box>
      <Typography
        variant="caption"
        sx={{ color: captionColour, display: 'inline-flex', alignItems: 'center', gap: 1 }}
      >
        {Icon === null ? null : <Icon size={14} aria-hidden="true" />}
        {caption}
      </Typography>
    </Box>
  );
}

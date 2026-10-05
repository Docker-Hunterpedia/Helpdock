import { Box, Typography } from '@mui/material';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/** DESIGN §6.2: the budget alert. */
export const USAGE_ALERT_PERCENT = 80;
const USAGE_FULL_PERCENT = 100;

type MeterTone = 'normal' | 'warning' | 'danger';

export const meterTone = (percent: number): MeterTone => {
  if (percent >= USAGE_FULL_PERCENT) {
    return 'danger';
  }
  return percent >= USAGE_ALERT_PERCENT ? 'warning' : 'normal';
};

/**
 * DESIGN §6.2 UsageMeter (M8-05: Storage and LLM spend on `Admin/System-1.0`).
 * A 4 px track filled to the share used, in the accent below 80 %, the warning
 * hue from 80 % and the danger hue at 100 %, with the share said in words in
 * the caption, which gains an icon from 80 % so the hue is never alone.
 */
export function UsageMeter({
  label,
  figure,
  percent,
  caption,
  accessibleLabel,
}: {
  /** Omitted in a table cell, where the column already names it. */
  readonly label?: string | undefined;
  /** The mono figure beside the label ("18.4 GB"). */
  readonly figure?: string | undefined;
  readonly percent: number;
  readonly caption: string;
  /**
   * The progress bar's name, naming the period ("Storage 37 %"). Without one
   * the bar is hidden from assistive technology, because the caption says it.
   */
  readonly accessibleLabel?: string | undefined;
}): ReactNode {
  const tokens = useSemanticTokens();
  const tone = meterTone(percent);
  const fill = {
    normal: tokens['action.primary'],
    warning: tokens['status.warning'],
    danger: tokens['status.danger'],
  }[tone];
  const captionColour = {
    normal: tokens['text.secondary'],
    warning: tokens['status.warning.text'],
    danger: tokens['status.danger.text'],
  }[tone];
  const width = Math.min(USAGE_FULL_PERCENT, Math.max(0, percent));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      {label === undefined && figure === undefined ? null : (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
          {label === undefined ? null : (
            <Typography component="span" sx={{ fontSize: 13, fontWeight: 500 }}>
              {label}
            </Typography>
          )}
          {figure === undefined ? null : (
            <Typography variant="mono" component="span">
              <bdi dir="ltr">{figure}</bdi>
            </Typography>
          )}
        </Box>
      )}
      <Box
        {...(accessibleLabel === undefined
          ? { 'aria-hidden': true }
          : {
              role: 'progressbar',
              'aria-label': accessibleLabel,
              'aria-valuenow': Math.round(percent),
              'aria-valuemin': 0,
              'aria-valuemax': USAGE_FULL_PERCENT,
            })}
        sx={{
          height: 4,
          borderRadius: '999px',
          backgroundColor: tokens['border.default'],
          overflow: 'hidden',
        }}
      >
        <Box sx={{ width: `${width}%`, height: '100%', backgroundColor: fill }} />
      </Box>
      <Typography
        variant="caption"
        component="p"
        sx={{
          color: captionColour,
          fontWeight: 400,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        {tone === 'normal' ? null : (
          <TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
        )}
        {caption}
      </Typography>
    </Box>
  );
}

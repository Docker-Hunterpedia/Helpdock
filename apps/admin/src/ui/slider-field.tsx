import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.1 SliderField: a bounded number picked by feel and read back
 * exactly — the auto-reply confidence threshold (M7-10, `Admin/AI-Assistant`).
 * A native range, 0 to 1 in steps of 0.05, then an `<output>` carrying the
 * value as text, so the number is never only a thumb position.
 */
export function SliderField({
  value,
  label,
  disabled = false,
  onChange,
}: {
  readonly value: number;
  /** What it sets, e.g. "Widget confidence threshold". */
  readonly label: string;
  readonly disabled?: boolean;
  onChange(value: number): void;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, minHeight: 40, flex: 1 }}>
      <Box
        component="input"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event: { target: HTMLInputElement }) => {
          onChange(Number(event.target.value));
        }}
        sx={{ flex: 1, minWidth: 0, accentColor: tokens['action.primary'] }}
      />
      <Typography
        component="output"
        variant="mono"
        dir="ltr"
        sx={{ width: 36, textAlign: 'end', fontSize: 13, flexShrink: 0 }}
      >
        {value.toFixed(2)}
      </Typography>
    </Box>
  );
}

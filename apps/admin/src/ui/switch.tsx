import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.1's Switch: a 36 × 20 track with a 16 px thumb, `action.primary`
 * when on and `border.strong` when off. A real `button` with `role="switch"`,
 * so the state is announced and a keyboard toggles it with Space or Enter; the
 * thumb's side says the state as well as the colour does.
 */
export function Switch({
  checked,
  label,
  disabled = false,
  onChange,
}: {
  readonly checked: boolean;
  /** The accessible name, e.g. "Enable Refunds to Billing". */
  readonly label: string;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="button"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      sx={{
        width: 36,
        height: 20,
        flexShrink: 0,
        padding: '2px',
        border: 0,
        borderRadius: '999px',
        cursor: disabled ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: checked ? 'flex-end' : 'flex-start',
        backgroundColor: checked ? tokens['action.primary'] : tokens['border.strong'],
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 120ms ease-out',
        '&:focus-visible': {
          outline: `2px solid ${tokens['border.focus']}`,
          outlineOffset: '2px',
        },
      }}
    >
      <Box
        component="span"
        sx={{
          width: 16,
          height: 16,
          borderRadius: '999px',
          backgroundColor: tokens['bg.surface'],
        }}
      />
    </Box>
  );
}

import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

export interface FieldProps {
  /** Also the input's `id`; the hint and error ids are derived from it. */
  readonly id: string;
  readonly label: string;
  /** Sits at the label's inline-end, such as the "Forgot password?" link. */
  readonly action?: ReactNode | undefined;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}

const fieldHintId = (id: string): string => `${id}-hint`;
const fieldErrorId = (id: string): string => `${id}-error`;

/**
 * What the input should point `aria-describedby` at: the error while there is
 * one, otherwise the hint. Returning `undefined` keeps the attribute off the
 * element entirely rather than setting it to an empty string.
 */
export function fieldDescribedBy(
  id: string,
  { hint, error }: { readonly hint?: string | undefined; readonly error?: string | undefined },
): string | undefined {
  if (error) {
    return fieldErrorId(id);
  }

  return hint ? fieldHintId(id) : undefined;
}

/**
 * DESIGN §6.1: label above the input at 13/500 with a 6 px gap, hint and error
 * below at 12. A real `<label for>` rather than a floating MUI label, because
 * the artboards put the label outside the box.
 */
export function Field({ id, label, action, hint, error, children }: FieldProps): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 3,
          marginBlockEnd: '6px',
        }}
      >
        <Typography
          component="label"
          htmlFor={id}
          sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px' }}
        >
          {label}
        </Typography>
        {action}
      </Box>
      {children}
      {error ? (
        <Typography
          id={fieldErrorId(id)}
          variant="caption"
          sx={{ marginBlockStart: '6px', color: tokens['status.danger.text'] }}
        >
          {error}
        </Typography>
      ) : hint ? (
        <Typography
          id={fieldHintId(id)}
          variant="caption"
          sx={{ marginBlockStart: '6px', color: 'text.secondary' }}
        >
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

import { Box, Checkbox, Typography } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * A fieldset of checkboxes, each a mono identifier over a caption: the scopes
 * of "Create API key" and the events of "Add endpoint". The identifier is the
 * label, so a screen reader reads `tickets:read` and then what it allows.
 */
export function CheckList<Value extends string>({
  legend,
  options,
  selected,
  error,
  onChange,
}: {
  readonly legend: string;
  readonly options: readonly { readonly value: Value; readonly hint: string }[];
  readonly selected: readonly Value[];
  readonly error?: string | undefined;
  onChange(next: readonly Value[]): void;
}): ReactNode {
  const tokens = useSemanticTokens();
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <Box
      component="fieldset"
      aria-describedby={error === undefined ? undefined : errorId}
      sx={{ margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <Typography component="legend" sx={{ fontSize: 13, fontWeight: 500, marginBlockEnd: 2 }}>
        {legend}
      </Typography>
      {options.map((option) => {
        const inputId = `${id}-${option.value}`;
        const checked = selected.includes(option.value);
        return (
          <Box key={option.value} sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Checkbox
              id={inputId}
              size="small"
              checked={checked}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? options
                        .map((o) => o.value)
                        .filter((value) => value === option.value || selected.includes(value))
                    : selected.filter((value) => value !== option.value),
                );
              }}
              slotProps={{ input: { 'aria-describedby': `${inputId}-hint` } }}
              sx={{ padding: 0, marginBlockStart: '2px' }}
            />
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography
                component="label"
                htmlFor={inputId}
                dir="ltr"
                sx={{
                  fontFamily: 'var(--hd-font-mono, monospace)',
                  fontSize: 13,
                  lineHeight: '20px',
                  alignSelf: 'flex-start',
                }}
              >
                {option.value}
              </Typography>
              <Typography id={`${inputId}-hint`} variant="caption" sx={{ color: 'text.secondary' }}>
                {option.hint}
              </Typography>
            </Box>
          </Box>
        );
      })}
      {error === undefined ? null : (
        <Typography id={errorId} variant="caption" sx={{ color: tokens['status.danger.text'] }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}

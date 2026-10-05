import { Box, Button, TextField } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { Field, fieldDescribedBy } from './field.tsx';

const MASKED = '••••••••••••';

/**
 * DESIGN §6.1 SecretField: a stored secret never reaches the browser, so the
 * field shows a fixed mask, read-only, with "Replace" at its inline end; Replace
 * opens it empty. `value` is null while the stored secret is kept.
 */
export function SecretField({
  id,
  label,
  stored,
  value,
  hint,
  error,
  replaceLabel,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  /** A secret is already saved, so the mask stands for it. */
  readonly stored: boolean;
  /** Null while the stored secret is kept; the typed value once Replace was pressed. */
  readonly value: string | null;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  /** Names what is replaced, e.g. "Replace the OpenAI API key". */
  readonly replaceLabel?: string;
  onChange(value: string | null): void;
}): ReactNode {
  const t = useT();
  const kept = value === null && stored;

  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Box sx={{ display: 'flex', gap: 2 }}>
        <TextField
          id={id}
          size="small"
          type="password"
          value={kept ? MASKED : (value ?? '')}
          error={error !== undefined}
          sx={{ flex: 1 }}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          slotProps={{
            htmlInput: {
              readOnly: kept,
              maxLength: 4_096,
              autoComplete: 'new-password',
              dir: 'ltr',
              'aria-describedby': fieldDescribedBy(id, { hint, error }),
            },
          }}
        />
        {kept ? (
          <Button
            variant="outlined"
            aria-label={replaceLabel}
            onClick={() => {
              onChange('');
            }}
          >
            {t('aiSettings:secret.replace')}
          </Button>
        ) : null}
      </Box>
    </Field>
  );
}

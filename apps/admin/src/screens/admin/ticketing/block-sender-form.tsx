import type { BlockedSenderCreateRequest, BlockedSenderKind } from '@helpdock/schemas';
import { blockedSenderKindSchema, MAX_IDENTITY_LENGTH } from '@helpdock/schemas';
import { Box, Button, MenuItem, Select, TextField, Typography } from '@mui/material';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.tsx';

/**
 * The side card of the Spam tab: "Block a sender", as the
 * `Admin/Ticketing › Spam` artboard draws it — Kind, Sender, and a refusal in
 * a danger banner under the field rather than a toast, because the person has
 * to fix what they typed and the sentence belongs next to it.
 *
 * Which refusal it is comes from the api (`sender-invalid`, `sender-is-own`,
 * `sender-already-blocked`); the card only draws the sentence it is handed.
 */
export function BlockSenderForm({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  readonly busy: boolean;
  /** The refusal's sentence, already translated; null while there is none. */
  readonly error: string | null;
  onSubmit(request: BlockedSenderCreateRequest): void;
  onCancel(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const kindId = useId();
  const valueId = useId();
  const errorId = useId();
  const headingId = useId();

  const [kind, setKind] = useState<BlockedSenderKind>('email');
  const [value, setValue] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (value.trim() === '') {
      return;
    }

    onSubmit({ kind, value: value.trim() });
  };

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-labelledby={headingId}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography id={headingId} variant="h3" component="h2">
        {t('ticketing:spam.form.heading')}
      </Typography>

      <Field id={kindId} label={t('ticketing:spam.form.kind')}>
        <Select
          id={kindId}
          value={kind}
          size="small"
          onChange={(event) => {
            setKind(event.target.value as BlockedSenderKind);
          }}
          inputProps={{ 'aria-label': t('ticketing:spam.form.kind') }}
        >
          {blockedSenderKindSchema.options.map((option) => (
            <MenuItem key={option} value={option}>
              {t(`ticketing:spam.form.kinds.${option}`)}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <Field
        id={valueId}
        label={t('ticketing:spam.form.value')}
        hint={t(`ticketing:spam.form.hints.${kind}`)}
      >
        <TextField
          id={valueId}
          value={value}
          size="small"
          required
          onChange={(event) => {
            setValue(event.target.value);
          }}
          error={error !== null}
          slotProps={{
            htmlInput: {
              maxLength: MAX_IDENTITY_LENGTH,
              dir: 'ltr',
              'aria-invalid': error !== null,
              ...(error === null ? {} : { 'aria-describedby': errorId }),
            },
          }}
        />
      </Field>

      {error === null ? null : (
        <Box id={errorId}>
          <AlertBanner tone="danger">{error}</AlertBanner>
        </Box>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button variant="text" onClick={onCancel} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || value.trim() === ''}>
          {t('ticketing:spam.form.submit')}
        </Button>
      </Box>
    </Box>
  );
}

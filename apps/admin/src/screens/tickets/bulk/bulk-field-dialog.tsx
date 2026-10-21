import type { CustomFieldDef } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { type CustomDraft, draftOf, valueOfDraft } from '../../../tickets/custom-values.js';
import { editorFor } from '../custom-fields-card.tsx';

/**
 * "Set a field" under More (M14-04): one of the brand's ticket fields and a
 * value, drawn with the very editors the details panel uses. The value is not
 * checked here; the preview asks the api, which refuses a ticket whose field
 * does not take it, and the dialog that follows says so per ticket.
 */
export function BulkFieldDialog({
  open,
  fields,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  readonly fields: readonly CustomFieldDef[];
  onSubmit(key: string, value: unknown): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const titleId = useId();
  const selectId = useId();
  const editorId = useId();
  const [key, setKey] = useState('');
  const [draft, setDraft] = useState<CustomDraft>('');
  const def = fields.find((candidate) => candidate.key === key) ?? fields[0];

  useEffect(() => {
    if (open) {
      const first = fields[0];
      setKey(first?.key ?? '');
      setDraft(first === undefined ? '' : draftOf(first, undefined));
    }
  }, [open, fields]);

  const labelOf = (field: CustomFieldDef): string =>
    locale === 'ar' && field.labelAr !== null ? field.labelAr : field.label;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (def !== undefined) {
      onSubmit(def.key, valueOfDraft(def, draft));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 400 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id={titleId} variant="h3">
          {t('tickets:bulk.field.title')}
        </DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 3 }}>
          {def === undefined ? (
            <Typography variant="body2" color="text.secondary">
              {t('tickets:bulk.field.none')}
            </Typography>
          ) : (
            <>
              <TextField
                id={selectId}
                select
                size="small"
                label={t('tickets:bulk.field.field')}
                value={def.key}
                onChange={(event) => {
                  const next = fields.find((candidate) => candidate.key === event.target.value);
                  setKey(event.target.value);
                  setDraft(next === undefined ? '' : draftOf(next, undefined));
                }}
              >
                {fields.map((field) => (
                  <MenuItem key={field.id} value={field.key}>
                    {labelOf(field)}
                  </MenuItem>
                ))}
              </TextField>
              <Box sx={{ display: 'grid', gap: 1 }}>
                <Typography
                  component="label"
                  htmlFor={editorId}
                  variant="caption"
                  color="text.secondary"
                >
                  {labelOf(def)}
                </Typography>
                {editorFor({
                  def,
                  id: editorId,
                  label: labelOf(def),
                  draft,
                  disabled: false,
                  refused: false,
                  described: undefined,
                  none: t('tickets:details.customNone'),
                  onDraft: setDraft,
                  onCommit: setDraft,
                })}
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ padding: 5, paddingBlockStart: 2 }}>
          <Button variant="text" onClick={onClose}>
            {t('tickets:bulk.field.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={def === undefined}>
            {t('tickets:bulk.field.submit')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

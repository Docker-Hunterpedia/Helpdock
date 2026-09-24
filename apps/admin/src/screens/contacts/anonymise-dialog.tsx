import { TextField, Typography } from '@mui/material';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { Field } from '../../ui/field.tsx';

/**
 * `Admin/Contact dialogs` panel 3: "Anonymise Mona Khalil?" (M1-14,
 * DOMAIN-RULES §11).
 *
 * The one irreversible action on the contact screen, so it asks for the
 * person's name to be typed before the danger button wakes up — the same
 * friction the brand's own deletion uses. The match is exact, as the artboard
 * says: a name that differs by a letter is a different person, and "close
 * enough" is the wrong standard for an erasure.
 */
export function AnonymiseDialog({
  open,
  name,
  busy,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly name: string;
  readonly busy: boolean;
  onConfirm(): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const inputId = useId();
  const [typed, setTyped] = useState('');

  // A dialog opened a second time starts empty, so a name typed for one
  // contact can never confirm the next one.
  useEffect(() => {
    if (open) {
      setTyped('');
    }
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      destructive
      busy={busy}
      confirmDisabled={typed !== name}
      title={t('contacts:confirm.anonymiseTitle', { name })}
      body={t('contacts:confirm.anonymiseLead')}
      confirmLabel={t('contacts:confirm.anonymiseSubmit')}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <Typography variant="body2">{t('contacts:confirm.anonymiseBody', { name })}</Typography>
      <Field id={inputId} label={t('contacts:confirm.anonymiseTypeName', { name })}>
        <TextField
          id={inputId}
          value={typed}
          autoComplete="off"
          size="small"
          fullWidth
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}

import { HC_NAME_MAX } from '@helpdock/schemas';
import { TextField } from '@mui/material';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { Field } from '../../ui/field.tsx';

export interface Names {
  readonly en: string;
  readonly ar: string;
}

/**
 * Naming a new category or section: an English and an Arabic name in the
 * DESIGN §6.4 Dialog. One of the two is enough; the other language falls back
 * to it on the help center, as a missing translation does.
 */
export function NamesDialog({
  open,
  title,
  body,
  busy,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  readonly busy: boolean;
  onSubmit(names: Names): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const enId = useId();
  const arId = useId();
  const [names, setNames] = useState<Names>({ en: '', ar: '' });
  const empty = names.en.trim() === '' && names.ar.trim() === '';

  const close = (): void => {
    setNames({ en: '', ar: '' });
    onClose();
  };

  return (
    <ConfirmDialog
      open={open}
      title={title}
      body={body}
      busy={busy}
      confirmLabel={t('helpCenter:tree.dialog.create')}
      confirmDisabled={empty}
      onClose={close}
      onConfirm={() => {
        onSubmit({ en: names.en.trim(), ar: names.ar.trim() });
        setNames({ en: '', ar: '' });
      }}
    >
      <Field id={enId} label={t('helpCenter:tree.dialog.english')}>
        <TextField
          id={enId}
          size="small"
          value={names.en}
          autoFocus
          onChange={(event) => {
            setNames({ ...names, en: event.target.value });
          }}
          slotProps={{ htmlInput: { maxLength: HC_NAME_MAX, lang: 'en', dir: 'ltr' } }}
        />
      </Field>
      <Field id={arId} label={t('helpCenter:tree.dialog.arabic')}>
        <TextField
          id={arId}
          size="small"
          value={names.ar}
          onChange={(event) => {
            setNames({ ...names, ar: event.target.value });
          }}
          slotProps={{ htmlInput: { maxLength: HC_NAME_MAX, lang: 'ar', dir: 'rtl' } }}
        />
      </Field>
    </ConfirmDialog>
  );
}

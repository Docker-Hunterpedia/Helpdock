import { TextField } from '@mui/material';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';

/**
 * M14-26's two filters on where a ticket arrived (`Admin/Ticketing-FieldFilters`):
 * the mailbox, picked from the brand's, and the address the customer wrote to,
 * typed. Shared by the Filter popover and the view editor, which draw the
 * mailbox as chips in their own style and the address with {@link WrittenToField}.
 * The brand's mailboxes arrive with the workspace's other directory reads.
 */

/**
 * The address a customer wrote to. It applies on Enter or when the field
 * loses focus, not on every keystroke, because each change is a new query and
 * a new link.
 */
export function WrittenToField({
  value,
  disabled = false,
  onChange,
}: {
  readonly value: string;
  readonly disabled?: boolean;
  onChange(value: string): void;
}): ReactNode {
  const t = useT();
  const id = useId();
  const [typed, setTyped] = useState(value);

  // A cleared filter, or another view, changes the value from outside.
  useEffect(() => {
    setTyped(value);
  }, [value]);

  const commit = (): void => {
    const next = typed.trim();
    if (next !== value) {
      onChange(next);
    }
  };

  return (
    <TextField
      id={id}
      size="small"
      value={typed}
      disabled={disabled}
      label={t('tickets:filters.writtenTo')}
      placeholder={t('tickets:filters.writtenToPlaceholder')}
      // A fixed (built-in) view's field is read-only, and disabled helper text fails contrast.
      helperText={disabled ? undefined : t('tickets:filters.writtenToHint')}
      onChange={(event) => {
        setTyped(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
      slotProps={{ htmlInput: { dir: 'ltr', maxLength: 320 } }}
      fullWidth
    />
  );
}

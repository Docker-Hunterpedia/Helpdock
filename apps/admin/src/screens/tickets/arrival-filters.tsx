import type { TicketMailbox } from '@helpdock/schemas';
import { TextField } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { currentBrand, useSession, useTicketsApi } from '../../auth/session.tsx';
import { ticketKeys } from '../../tickets/keys.js';

/**
 * M14-26's two filters on where a ticket arrived (`Admin/Ticketing-FieldFilters`):
 * the mailbox, picked from the brand's, and the address the customer wrote to,
 * typed. Shared by the Filter popover and the view editor, which draw the
 * mailbox as chips in their own style and the address with {@link WrittenToField}.
 */

const MAILBOXES_STALE_MS = 60_000;

/**
 * The brand's mailboxes. A read that fails leaves the list empty, which hides
 * the mailbox row: the filter is a convenience, not something to block the
 * list on.
 */
export function useTicketMailboxes(): readonly TicketMailbox[] {
  const api = useTicketsApi();
  const brandId = currentBrand(useSession()).id;
  const mailboxes = useQuery({
    queryKey: ticketKeys.mailboxes(brandId),
    queryFn: () => api.mailboxes(brandId),
    staleTime: MAILBOXES_STALE_MS,
    retry: false,
  });

  return mailboxes.data?.mailboxes ?? [];
}

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
      helperText={t('tickets:filters.writtenToHint')}
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

import type { MetaAccount } from '@helpdock/schemas';
import { TextField, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { metaKeys } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { ConfirmDialog } from '../../../../ui/confirm-dialog.tsx';
import { Field } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { accountLabel } from './platforms.js';

/**
 * "Disconnect Helpdock from Messenger?" (M10-07, `Admin/Channels-Meta-Account`
 * panel 3): the button stays off until the account's id is typed exactly,
 * because disconnecting cuts every open conversation it carries off from
 * Meta. The id rather than the name, because two accounts may share a name and
 * the id is what the Meta dashboard shows.
 */
export function DisconnectDialog({
  account,
  onClose,
  onDisconnected,
}: {
  /** Open while there is one. */
  readonly account: MetaAccount | null;
  onClose(): void;
  onDisconnected?: () => void;
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const [typed, setTyped] = useState('');

  const close = (): void => {
    setTyped('');
    onClose();
  };

  const remove = useMutation({
    mutationFn: (target: MetaAccount) => api.deleteAccount(brand.id, target.id),
    onSuccess: async (_result, target) => {
      await queryClient.invalidateQueries({ queryKey: metaKeys.accounts(brand.id) });
      toast({
        tone: 'success',
        message: t('channels:meta.toast.disconnected', { name: accountLabel(target) }),
      });
      close();
      onDisconnected?.();
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const platform = account?.platform ?? 'whatsapp';
  const externalId = account?.externalId ?? '';

  return (
    <ConfirmDialog
      open={account !== null}
      title={t('channels:meta.disconnectConfirm.title', {
        name: account === null ? '' : accountLabel(account),
        platform: t(`channels:meta.platforms.${platform}`),
      })}
      body={t(`channels:meta.disconnectConfirm.body.${platform}`, {
        department: account?.departmentName ?? '',
      })}
      confirmLabel={t('channels:meta.disconnectConfirm.action')}
      destructive
      busy={remove.isPending}
      confirmDisabled={typed !== externalId}
      onConfirm={() => {
        if (account !== null) {
          remove.mutate(account);
        }
      }}
      onClose={close}
    >
      <Field
        id={id}
        label={t(`channels:meta.disconnectConfirm.typeLabel.${platform}`, { id: externalId })}
      >
        <TextField
          id={id}
          size="small"
          autoComplete="off"
          value={typed}
          placeholder={externalId}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          slotProps={{ htmlInput: { dir: 'ltr', spellCheck: false } }}
          sx={{ '& input': (theme) => theme.typography.mono }}
        />
      </Field>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('channels:meta.disconnectConfirm.footnote')}
      </Typography>
    </ConfirmDialog>
  );
}

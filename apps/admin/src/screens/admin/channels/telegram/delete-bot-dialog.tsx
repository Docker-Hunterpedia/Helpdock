import type { TelegramBot } from '@helpdock/schemas';
import { TextField } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { telegramKeys } from '../../../../telegram/api.js';
import { useTelegramApi } from '../../../../telegram/context.tsx';
import { ConfirmDialog } from '../../../../ui/confirm-dialog.tsx';
import { Field } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';

/**
 * "Delete @bot?" (M6-05, `Admin/Channels-Telegram` panel 3): the button stays
 * off until `@username` is typed exactly, because deleting a bot cuts every
 * open conversation it carries off from Telegram.
 */
export function DeleteBotDialog({
  bot,
  onClose,
  onDeleted,
}: {
  /** Open while there is one. */
  readonly bot: TelegramBot | null;
  onClose(): void;
  onDeleted?: () => void;
}): ReactNode {
  const t = useT();
  const api = useTelegramApi();
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
    mutationFn: (target: TelegramBot) => api.deleteBot(brand.id, target.id),
    onSuccess: async (_result, target) => {
      await queryClient.invalidateQueries({ queryKey: telegramKeys.bots(brand.id) });
      toast({
        tone: 'success',
        message: t('channels:telegram.toast.deleted', { username: target.username }),
      });
      close();
      onDeleted?.();
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const username = bot?.username ?? '';
  const label = t('channels:telegram.deleteConfirm.typeLabel', { username });

  return (
    <ConfirmDialog
      open={bot !== null}
      title={t('channels:telegram.deleteConfirm.title', { username })}
      body={t('channels:telegram.deleteConfirm.body', { department: bot?.departmentName ?? '' })}
      confirmLabel={t('channels:telegram.deleteConfirm.action')}
      destructive
      busy={remove.isPending}
      confirmDisabled={typed !== `@${username}`}
      onConfirm={() => {
        if (bot !== null) {
          remove.mutate(bot);
        }
      }}
      onClose={close}
    >
      <Field id={id} label={label}>
        <TextField
          id={id}
          size="small"
          autoComplete="off"
          value={typed}
          placeholder={`@${username}`}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          slotProps={{ htmlInput: { dir: 'ltr', spellCheck: false } }}
        />
      </Field>
    </ConfirmDialog>
  );
}

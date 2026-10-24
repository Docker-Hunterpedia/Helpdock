import type { PasskeyProof } from '@helpdock/schemas';
import { Button, TextField, Typography } from '@mui/material';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import {
  assertPasskey,
  isPasskeyCeremonyError,
  passkeysSupported,
} from '../../auth/passkey-ceremony.js';
import { useAuthApi } from '../../auth/session.tsx';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';

/** A password is at least twelve characters, so six digits can only be a code. */
export const secretProof = (value: string): PasskeyProof =>
  /^\d{6}$/.test(value) ? { code: value } : { currentPassword: value };

/**
 * "Confirm it's you": the passkey button, then the password or a code in one
 * field. The passkey answers at once (the browser prompt is the confirmation);
 * the field's value goes on with Continue.
 */
export function StepUpDialog({
  body,
  hasPasskeys,
  busy,
  error,
  onProof,
  onClose,
}: {
  readonly body: string;
  readonly hasPasskeys: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  onProof(proof: PasskeyProof): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const fieldId = useId();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const shown = problem ?? error;

  const confirmWithPasskey = async (): Promise<void> => {
    setAsking(true);
    setProblem(null);
    try {
      const { ceremonyId, options } = await api.passkeyStepUpOptions();
      const response = await assertPasskey(options);
      onProof({ passkey: { ceremonyId, response } });
    } catch (failure) {
      const cancelled = isPasskeyCeremonyError(failure) && failure.reason === 'cancelled';
      if (!cancelled) setProblem(t('me:passkeys.passkeyProofFailed'));
    } finally {
      setAsking(false);
    }
  };

  return (
    <ConfirmDialog
      open
      busy={busy || asking}
      title={t('me:passkeys.stepUpTitle')}
      body={body}
      confirmLabel={t('me:passkeys.continue')}
      onClose={onClose}
      onConfirm={() => {
        if (value === '') {
          setProblem(t('me:passkeys.proofRequired'));
          return;
        }
        setProblem(null);
        onProof(secretProof(value));
      }}
    >
      {hasPasskeys && passkeysSupported() ? (
        <>
          <Button
            variant="outlined"
            startIcon={<KeyRound size={16} aria-hidden="true" />}
            disabled={busy || asking}
            onClick={() => {
              void confirmWithPasskey();
            }}
          >
            {t('me:passkeys.usePasskey')}
          </Button>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', textAlign: 'center' }}
            aria-hidden="true"
          >
            {t('me:passkeys.or')}
          </Typography>
        </>
      ) : null}
      <TextField
        id={fieldId}
        type="password"
        label={t('me:passkeys.proofLabel')}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        error={shown !== null}
        helperText={shown ?? ' '}
        fullWidth
        slotProps={{ htmlInput: { autoComplete: 'current-password' } }}
      />
    </ConfirmDialog>
  );
}

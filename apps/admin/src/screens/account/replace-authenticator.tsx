import type { TotpRotationProof, TotpRotationStart } from '@helpdock/schemas';
import { totpCodeRequestSchema } from '@helpdock/schemas';
import { monoFontStyle } from '@helpdock/ui';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { isAuthError } from '../../auth/api.js';
import {
  assertPasskey,
  isPasskeyCeremonyError,
  passkeysSupported,
} from '../../auth/passkey-ceremony.js';
import { useAuthApi, useStaffApi } from '../../auth/session.tsx';
import { QrCode } from '../../ui/qr-code.tsx';
import { useToast } from '../../ui/toasts.tsx';

/**
 * Replacing the authenticator app on `/me/security` (#373, artboard
 * `Admin/Profile-Security-ReplaceApp`). An account that must have a second
 * factor and holds only the app can neither turn it off nor enrol over it, so
 * this is the one way to move to a new phone: confirm it's you (a code from the
 * current app, a recovery code, a passkey, or the password with a recovery
 * code), scan the new secret, and type one code from the new app. The api swaps
 * the secret only then, in one step, so the old app keeps working until the
 * new one has proved itself.
 *
 * The two steps follow the two patterns the page already has: the proof step is
 * the Passkeys card's "Confirm it's you" dialog, and the scan step is the
 * enrolment screen's QR and key, drawn in the browser for the same reason —
 * the `otpauth://` URI is a credential.
 */

type Step = 'proof' | 'scan';
/** Which proof fields the first step shows. */
type ProofMode = 'secret' | 'password';

/** The key as authenticator apps print it: groups of four, read aloud and typed by hand. */
const groupsOf4 = (key: string): string => key.replace(/(.{4})(?=.)/g, '$1 ');

/** A six-digit value is an app code; anything else is read as a recovery code. */
const proofOf = (value: string): TotpRotationProof =>
  /^\d{6}$/.test(value.trim()) ? { code: value.trim() } : { recoveryCode: value.trim() };

export function ReplaceAuthenticatorDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  /** `stale` when the replacement expired or the factors changed under it: the page says "start again". */
  onClose(outcome?: 'stale'): void;
}): ReactNode {
  const t = useT();
  const api = useStaffApi();
  const authApi = useAuthApi();
  const toast = useToast();
  const queryClient = useQueryClient();

  const passkeyButtonId = useId();
  const proofId = useId();
  const passwordId = useId();
  const codeId = useId();

  const [step, setStep] = useState<Step>('proof');
  const [mode, setMode] = useState<ProofMode>('secret');
  const [secret, setSecret] = useState('');
  const [password, setPassword] = useState('');
  const [proofError, setProofError] = useState<string | null>(null);
  const [staged, setStaged] = useState<TotpRotationStart | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // Reopened from the button, not resumed: a half-finished proof is discarded,
  // and a staged secret from an earlier visit is never shown again.
  useEffect(() => {
    if (open) {
      setStep('proof');
      setMode('secret');
      setSecret('');
      setPassword('');
      setProofError(null);
      setStaged(null);
      setCode('');
      setCodeError(null);
    }
  }, [open]);

  const close = (): void => {
    onClose();
  };

  const fail = (error: unknown): void => {
    if (isAuthError(error) && error.code === 'challenge-expired') {
      onClose('stale');
      return;
    }
    close();
    toast({ tone: 'danger', message: t('me:security.failed') });
  };

  const start = useMutation({
    mutationFn: (proof: TotpRotationProof) => api.startTotpRotation(proof),
    onSuccess: (staged) => {
      setProofError(null);
      setSecret('');
      setPassword('');
      setStaged(staged);
      setStep('scan');
    },
    onError: (error) => {
      if (isAuthError(error) && error.code === 'totp-locked') {
        setProofError(t('me:passkeys.locked'));
        return;
      }
      if (
        isAuthError(error) &&
        (error.code === 'invalid-credentials' ||
          error.code === 'recovery-invalid' ||
          error.code === 'totp-mismatch')
      ) {
        setProofError(t('me:passkeys.proofWrong'));
        return;
      }
      fail(error);
    },
  });

  const confirm = useMutation({
    mutationFn: (request: { rotationId: string; code: string }) =>
      api.confirmTotpRotation(request.rotationId, request.code),
    onSuccess: async () => {
      close();
      await queryClient.invalidateQueries({ queryKey: ['me', 'profile'] });
      toast({ tone: 'success', message: t('me:twoFactor.replaced') });
    },
    onError: (error) => {
      if (isAuthError(error) && error.code === 'totp-mismatch') {
        setCodeError(t('me:twoFactor.codeWrong'));
        return;
      }
      if (isAuthError(error) && error.code === 'totp-locked') {
        setCodeError(t('me:passkeys.locked'));
        return;
      }
      fail(error);
    },
  });

  const confirmWithPasskey = async (): Promise<void> => {
    setAsking(true);
    setProofError(null);
    try {
      const { ceremonyId, options } = await authApi.passkeyStepUpOptions();
      const response = await assertPasskey(options);
      start.mutate({ passkey: { ceremonyId, response } });
    } catch (error) {
      if (!isPasskeyCeremonyError(error) || error.reason !== 'cancelled') {
        setProofError(t('me:passkeys.passkeyProofFailed'));
      }
    } finally {
      setAsking(false);
    }
  };

  const submitProof = (): void => {
    if (mode === 'password') {
      if (password === '' || secret.trim() === '') {
        setProofError(t('me:passkeys.proofRequired'));
        return;
      }
      setProofError(null);
      start.mutate({ currentPassword: password, recoveryCode: secret.trim() });
      return;
    }
    if (secret.trim() === '') {
      setProofError(t('me:twoFactor.replaceProofRequired'));
      return;
    }
    setProofError(null);
    start.mutate(proofOf(secret));
  };

  const submitCode = (): void => {
    if (staged === null) return;
    if (!totpCodeRequestSchema.shape.code.safeParse(code).success) {
      setCodeError(t('me:twoFactor.replaceProofRequired'));
      return;
    }
    setCodeError(null);
    confirm.mutate({ rotationId: staged.rotationId, code });
  };

  if (!open) {
    return null;
  }

  const busy = start.isPending || confirm.isPending || asking;

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) close();
      }}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 480, borderRadius: '10px' } } }}
    >
      {step === 'proof' ? (
        <>
          <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
            {t('me:passkeys.stepUpTitle')}
          </DialogTitle>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('me:twoFactor.replaceBody')}
            </Typography>

            {passkeysSupported() ? (
              <>
                <Button
                  id={passkeyButtonId}
                  variant="outlined"
                  startIcon={<KeyRound size={16} aria-hidden="true" />}
                  disabled={busy}
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

            {mode === 'secret' ? (
              <TextField
                id={proofId}
                label={t('me:twoFactor.replaceProofLabel')}
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                }}
                error={proofError !== null}
                helperText={proofError ?? ' '}
                fullWidth
                slotProps={{ htmlInput: { autoComplete: 'one-time-code' } }}
              />
            ) : (
              <>
                <TextField
                  id={passwordId}
                  type="password"
                  label={t('me:password.currentLabel')}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                  error={proofError !== null}
                  helperText={proofError ?? ' '}
                  fullWidth
                  slotProps={{ htmlInput: { autoComplete: 'current-password' } }}
                />
                <TextField
                  id={proofId}
                  label={t('me:twoFactor.recoveryLabel')}
                  value={secret}
                  onChange={(event) => {
                    setSecret(event.target.value);
                  }}
                  error={proofError !== null}
                  helperText={proofError ?? ' '}
                  fullWidth
                />
              </>
            )}

            <Button
              variant="text"
              size="small"
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setProofError(null);
                setSecret('');
                setPassword('');
                setMode(mode === 'secret' ? 'password' : 'secret');
              }}
            >
              {mode === 'secret' ? t('me:twoFactor.usePassword') : t('me:twoFactor.useCode')}
            </Button>
          </DialogContent>
          <DialogActions sx={{ padding: 4 }}>
            <Button variant="text" disabled={busy} onClick={close}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="contained" disabled={busy} onClick={submitProof}>
              {t('me:passkeys.continue')}
            </Button>
          </DialogActions>
        </>
      ) : (
        <>
          <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
            {t('me:twoFactor.scanTitle')}
          </DialogTitle>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('me:twoFactor.scanBody')}
            </Typography>

            <Box sx={{ display: 'flex', justifyContent: 'center' }}>
              <QrCode value={staged?.uri ?? ''} label={t('auth:enrolment.step1.qrAlt')} />
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('me:twoFactor.keyLabel')}
              </Typography>
              <Typography
                variant="body2"
                dir="ltr"
                sx={{ ...monoFontStyle, wordBreak: 'break-all' }}
              >
                {groupsOf4(staged?.secret ?? '')}
              </Typography>
            </Box>

            <Box
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                submitCode();
              }}
              sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <TextField
                id={codeId}
                label={t('me:twoFactor.newCodeLabel')}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                error={codeError !== null}
                helperText={codeError ?? ' '}
                fullWidth
                slotProps={{
                  htmlInput: {
                    dir: 'ltr',
                    inputMode: 'numeric',
                    autoComplete: 'one-time-code',
                    maxLength: 6,
                    style: monoFontStyle,
                  },
                  formHelperText: { role: codeError === null ? undefined : 'alert' },
                }}
              />
            </Box>
          </DialogContent>
          <DialogActions sx={{ padding: 4 }}>
            <Button variant="text" disabled={confirm.isPending} onClick={close}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="contained" disabled={confirm.isPending} onClick={submitCode}>
              {t('me:twoFactor.replace')}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

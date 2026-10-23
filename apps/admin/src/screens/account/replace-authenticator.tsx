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
  OutlinedInput,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { isAuthError } from '../../auth/api.js';
import {
  assertPasskey,
  isPasskeyCeremonyError,
  passkeysSupported,
} from '../../auth/passkey-ceremony.js';
import { useAuthApi, useStaffApi } from '../../auth/session.tsx';
import { AlertBanner } from '../../ui/alert-banner.tsx';
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

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // A browser with no clipboard permission is not a failure worth a banner:
    // the key is on screen and can be selected.
    return false;
  }
};

/** A six-digit value is an app code; anything else is read as a recovery code. */
const proofOf = (value: string): TotpRotationProof =>
  /^\d{6}$/.test(value.trim()) ? { code: value.trim() } : { recoveryCode: value.trim() };

export function ReplaceAuthenticatorDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const api = useStaffApi();
  const authApi = useAuthApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const tokens = useSemanticTokens();

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
  const [copied, setCopied] = useState(false);
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
      setCopied(false);
    }
  }, [open]);

  const close = (): void => {
    onClose();
  };

  const fail = (error: unknown): void => {
    close();
    toast({
      tone: 'danger',
      message:
        isAuthError(error) && error.code === 'challenge-expired'
          ? t('me:passkeys.expired')
          : t('me:security.failed'),
    });
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
            {t('me:twoFactor.replaceTitle')}
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
                {t('auth:enrolment.step1.manualLabel')}
              </Typography>
              <Paper
                elevation={0}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 3,
                  padding: 3,
                  borderRadius: '8px',
                  backgroundColor: tokens['bg.muted'],
                }}
              >
                <Typography variant="body2" sx={{ ...monoFontStyle, wordBreak: 'break-all' }}>
                  <bdi>{staged?.secret ?? ''}</bdi>
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={copied ? <Check size={16} /> : <Copy size={16} />}
                  onClick={() => {
                    void copyToClipboard(staged?.secret ?? '').then((done) => {
                      setCopied(done);
                    });
                  }}
                >
                  {t('auth:enrolment.step1.copyKey')}
                </Button>
              </Paper>
              {copied ? (
                <Typography role="status" variant="caption" sx={{ color: 'text.secondary' }}>
                  {t('auth:enrolment.step1.keyCopied')}
                </Typography>
              ) : null}
            </Box>

            <AlertBanner tone="info">{t('me:twoFactor.scanNote')}</AlertBanner>

            <Box
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                submitCode();
              }}
              sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <OutlinedInput
                id={codeId}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                error={codeError !== null}
                fullWidth
                sx={{
                  height: 44,
                  '& input': {
                    ...monoFontStyle,
                    fontSize: 20,
                    letterSpacing: '0.18em',
                    textAlign: 'center',
                  },
                }}
                slotProps={{
                  input: {
                    dir: 'ltr',
                    inputMode: 'numeric',
                    autoComplete: 'one-time-code',
                    maxLength: 6,
                    'aria-label': t('me:twoFactor.newCodeLabel'),
                  },
                }}
              />
              {codeError === null ? null : (
                <Typography variant="caption" sx={{ color: 'error.main' }} role="alert">
                  {codeError}
                </Typography>
              )}
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

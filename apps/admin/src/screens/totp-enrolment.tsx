import { totpCodeRequestSchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Link,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Download } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../app/i18n.js';
import { DEFAULT_SIGNED_IN_ROUTE, ROUTES } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { isAuthError } from '../auth/api.js';
import { useAuthApi } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { QrCode } from '../ui/qr-code.tsx';
import { AuthLayout } from './auth-layout.tsx';

/**
 * `Admin/Enrol2FA`: where an install with `auth.require2fa` on sends an account
 * that has no authenticator yet, and where a newly accepted invitation lands.
 *
 * Two steps, in this order for a reason. The secret is **staged** by step one
 * and only becomes the account's second factor when a live code proves the
 * authenticator holds it — so a scan that did not save cannot lock anybody out.
 * The recovery codes then appear once, and the "Continue" button is gated on a
 * checkbox, because the single most expensive support ticket a self-hosted
 * install can generate is somebody who clicked past them.
 */

type Step = 'scan' | 'codes';

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

/** The address and the issuer the staged URI names, for the caption under the key. */
const describeUri = (uri: string): { account: string; issuer: string } => {
  try {
    const parsed = new URL(uri);
    const label = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    const [issuerFromLabel, account] = label.includes(':') ? label.split(':') : ['', label];

    return {
      account: account ?? '',
      issuer: parsed.searchParams.get('issuer') ?? issuerFromLabel ?? '',
    };
  } catch {
    return { account: '', issuer: '' };
  }
};

export function TotpEnrolment(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const navigate = useNavigate();
  const tokens = useSemanticTokens();
  const codeFieldId = useId();

  const [step, setStep] = useState<Step>('scan');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'key' | 'codes' | null>(null);
  const [saved, setSaved] = useState(false);

  const enrolment = useMutation({ mutationFn: () => api.enrolTotp() });
  const { mutate: startEnrolment } = enrolment;
  const staged = useRef(false);

  /**
   * Staged once, when the screen opens.
   *
   * Every call mints a *new* secret server-side, so this effect cannot be made
   * idempotent — and `StrictMode` invokes an effect twice in development, which
   * would replace the secret the QR code was already drawn from. A person
   * scanning the first one would then be typing a code for a secret the server
   * has forgotten. The ref is the guard React's own guidance prescribes for a
   * one-shot effect that has a side effect it cannot repeat.
   */
  useEffect(() => {
    if (staged.current) {
      return;
    }

    staged.current = true;
    startEnrolment();
  }, [startEnrolment]);

  const confirm = useMutation({
    mutationFn: (value: string) => api.confirmTotp(value),
    onSuccess: () => {
      setStep('codes');
    },
    onError: (error) => {
      setCodeError(
        isAuthError(error) && error.code === 'totp-mismatch'
          ? t('me:twoFactor.codeWrong')
          : t('auth:unavailable'),
      );
    },
  });

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    onSettled: () => {
      void navigate(ROUTES.signIn, { replace: true });
    },
  });

  const recoveryCodes = confirm.data?.recoveryCodes ?? [];
  const uri = enrolment.data?.uri ?? '';
  const secret = enrolment.data?.secret ?? '';
  const { account, issuer } = describeUri(uri);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!totpCodeRequestSchema.shape.code.safeParse(code).success) {
      setCodeError(t('auth:enrolment.step1.codeRequired'));
      return;
    }

    setCodeError(null);
    confirm.mutate(code);
  };

  const download = (): void => {
    const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = t('auth:enrolment.step2.fileName');
    anchor.click();
    // Revoking synchronously races the download in Firefox and Safari, and
    // these are the one file a person must not lose.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  if (step === 'codes') {
    return (
      <AuthLayout
        title={t('auth:enrolment.step2.title')}
        subtitle={t('auth:enrolment.step2.body')}
        width={520}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <AlertBanner tone="info">
            {t('auth:enrolment.step2.banner', { email: account })}
          </AlertBanner>

          <Box
            component="ul"
            aria-label={t('auth:enrolment.step2.listLabel')}
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 2,
              margin: 0,
              padding: 4,
              listStyle: 'none',
              borderRadius: '8px',
              backgroundColor: tokens['bg.muted'],
              fontFamily: 'var(--hd-font-mono, monospace)',
            }}
          >
            {recoveryCodes.map((recoveryCode) => (
              <Typography
                key={recoveryCode}
                component="li"
                variant="body2"
                sx={{ fontFamily: 'inherit' }}
              >
                <bdi>{recoveryCode}</bdi>
              </Typography>
            ))}
          </Box>

          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button variant="outlined" onClick={download} startIcon={<Download size={16} />}>
              {t('auth:enrolment.step2.download')}
            </Button>
            <Button
              variant="outlined"
              startIcon={copied === 'codes' ? <Check size={16} /> : <Copy size={16} />}
              onClick={() => {
                void copyToClipboard(recoveryCodes.join('\n')).then((done) => {
                  setCopied(done ? 'codes' : null);
                });
              }}
            >
              {t('auth:enrolment.step2.copyAll')}
            </Button>
          </Box>
          {copied === 'codes' ? (
            <Typography role="status" variant="caption" sx={{ color: 'text.secondary' }}>
              {t('auth:enrolment.step2.codesCopied')}
            </Typography>
          ) : null}

          <FormControlLabel
            control={
              <Checkbox
                checked={saved}
                onChange={(event) => {
                  setSaved(event.target.checked);
                }}
              />
            }
            label={t('auth:enrolment.step2.confirm')}
          />

          <Button
            variant="contained"
            disabled={!saved}
            onClick={() => {
              void navigate(DEFAULT_SIGNED_IN_ROUTE, { replace: true });
            }}
          >
            {t('auth:enrolment.step2.continue')}
          </Button>
        </Box>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t('auth:enrolment.title')}
      subtitle={t('auth:enrolment.subtitle')}
      width={520}
      footer={
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link
            component="button"
            type="button"
            variant="caption"
            onClick={() => {
              signOut.mutate();
            }}
          >
            {t('auth:enrolment.step1.signOut')}
          </Link>
        </Box>
      }
    >
      <Box
        component="form"
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('auth:enrolment.step1.body')}
        </Typography>

        {enrolment.isError ? (
          <AlertBanner tone="danger">{t('auth:unavailable')}</AlertBanner>
        ) : null}

        {uri === '' ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('common:loading')}
          </Typography>
        ) : (
          <>
            <Box sx={{ display: 'flex', justifyContent: 'center' }}>
              <QrCode value={uri} label={t('auth:enrolment.step1.qrAlt')} />
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
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'var(--hd-font-mono, monospace)', wordBreak: 'break-all' }}
                >
                  <bdi>{secret}</bdi>
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={copied === 'key' ? <Check size={16} /> : <Copy size={16} />}
                  onClick={() => {
                    void copyToClipboard(secret).then((done) => {
                      setCopied(done ? 'key' : null);
                    });
                  }}
                >
                  {t('auth:enrolment.step1.copyKey')}
                </Button>
              </Paper>
              {copied === 'key' ? (
                <Typography role="status" variant="caption" sx={{ color: 'text.secondary' }}>
                  {t('auth:enrolment.step1.keyCopied')}
                </Typography>
              ) : null}
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('auth:enrolment.step1.account', { email: account, issuer })}
              </Typography>
            </Box>
          </>
        )}

        <TextField
          id={codeFieldId}
          label={t('auth:enrolment.step1.codeLabel')}
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
          }}
          error={codeError !== null}
          helperText={codeError ?? t('auth:enrolment.step1.codeHint')}
          slotProps={{
            htmlInput: {
              inputMode: 'numeric',
              autoComplete: 'one-time-code',
              maxLength: 6,
              // 44 px, mono, and wide enough that six digits do not crowd.
              style: { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 18, height: 44 },
            },
          }}
        />

        <Button type="submit" variant="contained" disabled={confirm.isPending}>
          {t('auth:enrolment.step1.submit')}
        </Button>
      </Box>
    </AuthLayout>
  );
}

import type { SecondFactorOptions } from '@helpdock/schemas';
import { monoFontStyle } from '@helpdock/ui';
import { Box, Button, Checkbox, FormControlLabel, Link, OutlinedInput } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Navigate, Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES, safeReturnTo } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { isAuthError } from '../auth/api.js';
import { retryAfterMinutes } from '../auth/auth-error.js';
import { assertPasskey, isPasskeyCeremonyError } from '../auth/passkey-ceremony.js';
import { useAuthApi, useSetSession } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../ui/field.tsx';
import { AuthLayout } from './auth-layout.tsx';

/** What `SignIn` hands over when the api asks for a second factor. */
export interface TotpChallengeState {
  readonly challengeId: string;
  readonly email: string;
  /** What can answer the challenge; an app alone when a link from before passkeys did not say. */
  readonly factors?: SecondFactorOptions;
  readonly returnTo?: string;
}

const APP_ONLY: SecondFactorOptions = { totp: true, passkey: false };

const TOTP_LENGTH = 6;

const isChallengeState = (state: unknown): state is TotpChallengeState =>
  typeof state === 'object' &&
  state !== null &&
  typeof (state as TotpChallengeState).challengeId === 'string' &&
  typeof (state as TotpChallengeState).email === 'string';

interface Failure {
  readonly message: string;
  /** A lock is final: the form stops accepting input until a new sign-in. */
  readonly locked: boolean;
}

/** Turns the api's failure code into the sentence and the state it implies. */
function describeFailure(t: ReturnType<typeof useT>, error: unknown): Failure {
  if (!isAuthError(error)) {
    return { message: t('auth:unavailable'), locked: false };
  }

  switch (error.code) {
    case 'rate-limited': {
      const minutes = retryAfterMinutes(error.retryAfter);
      return {
        message: t('auth:signIn.rateLimited', { count: minutes }),
        locked: false,
      };
    }
    case 'totp-locked':
      return { message: t('auth:totp.locked'), locked: true };
    case 'passkey-invalid':
      return {
        message: t('auth:secondFactor.failed', { count: error.attemptsLeft ?? 0 }),
        locked: false,
      };
    case 'passkeys-rp-changed':
    case 'passkeys-unavailable':
      return { message: t('auth:secondFactor.rpChanged'), locked: false };
    case 'challenge-expired':
      return { message: t('auth:totp.expired'), locked: true };
    case 'recovery-invalid':
      return { message: t('auth:totp.recoveryMismatch'), locked: false };
    default:
      return {
        message: t('auth:totp.mismatch', { count: error.attemptsLeft ?? 0 }),
        locked: false,
      };
  }
}

/**
 * The artboards `Admin/TOTP` and `Admin/SecondFactor`, including the
 * recovery-code mode the first toggles into. An account with a passkey sees the
 * second: "Use your passkey" first, then the code, then the recovery link. An
 * account with an authenticator app alone sees today's screen, unchanged.
 */
export function Totp(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** A dismissed browser prompt is not a failure and spends nothing; it only says so. */
  const [notice, setNotice] = useState<string | null>(null);
  const tokens = useSemanticTokens();

  const challenge = isChallengeState(location.state) ? location.state : null;
  const factors = challenge?.factors ?? APP_ONLY;

  const verify = useMutation({
    mutationFn: async () => {
      // The closure was built before the redirect below could narrow this.
      if (!challenge) {
        throw new Error('there is no challenge to answer');
      }

      if (recoveryMode) {
        // biome-ignore lint/correctness/useHookAtTopLevel: a method on the auth contract, not a React hook — the name is the api's.
        return api.useRecoveryCode(challenge.challengeId, code);
      }

      return api.verifyTotp(challenge.challengeId, code, { trustDevice });
    },
    onSuccess: (session) => {
      setSession(session);
      void navigate(safeReturnTo(challenge?.returnTo), { replace: true });
    },
    onError: (error: unknown) => {
      setCode('');
      setFailure(describeFailure(t, error));
    },
  });

  const passkey = useMutation({
    mutationFn: async () => {
      if (!challenge) {
        throw new Error('there is no challenge to answer');
      }

      const { ceremonyId, options } = await api.passkeySecondFactorOptions(challenge.challengeId);
      const response = await assertPasskey(options);
      return api.verifyPasskey(challenge.challengeId, { ceremonyId, response }, { trustDevice });
    },
    onSuccess: (session) => {
      setSession(session);
      void navigate(safeReturnTo(challenge?.returnTo), { replace: true });
    },
    onError: (error: unknown) => {
      if (isPasskeyCeremonyError(error)) {
        setFailure(null);
        setNotice(
          t(
            error.reason === 'cancelled'
              ? 'auth:secondFactor.cancelled'
              : error.reason === 'unsupported'
                ? 'auth:secondFactor.unsupported'
                : 'auth:secondFactor.unreadable',
          ),
        );
        return;
      }
      setNotice(null);
      setFailure(describeFailure(t, error));
    },
  });

  // Reaching this screen without a challenge means a reload or a pasted URL;
  // there is nothing to verify, so it starts over rather than showing a form
  // that cannot succeed.
  if (!challenge) {
    return <Navigate to={ROUTES.signIn} replace />;
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!failure?.locked) {
      setNotice(null);
      verify.mutate();
    }
  };

  const toggleRecoveryMode = (): void => {
    setRecoveryMode((current) => !current);
    setCode('');
    setFailure(null);
    setNotice(null);
  };

  const onCodeChange = (value: string): void => {
    // The authenticator code is six digits, so the field only accepts six
    // digits: an invalid state the user cannot reach needs no error message.
    setCode(recoveryMode ? value : value.replace(/\D/g, '').slice(0, TOTP_LENGTH));
  };

  const locked = failure?.locked ?? false;
  const fieldId = 'totp-code';
  const ready = recoveryMode ? code.trim().length > 0 : code.length === TOTP_LENGTH;
  const hint = recoveryMode ? t('auth:totp.recoveryCodeHint') : t('auth:totp.rotationHint');
  /** The code form: always for an app, and for a passkey account that still has one. */
  const showCode = recoveryMode || factors.totp;
  const showPasskey = factors.passkey && !recoveryMode;
  const withPasskey = factors.passkey;
  const busy = verify.isPending || passkey.isPending;

  return (
    <AuthLayout
      width={520}
      title={withPasskey ? t('auth:secondFactor.title') : t('auth:totp.title')}
      subtitle={
        recoveryMode
          ? t('auth:totp.recoverySubtitle')
          : withPasskey
            ? t('auth:secondFactor.subtitle', { email: challenge.email })
            : t('auth:totp.subtitle', { email: challenge.email })
      }
      footer={
        failure ? (
          <AlertBanner tone="danger">{failure.message}</AlertBanner>
        ) : notice ? (
          <AlertBanner tone="info">{notice}</AlertBanner>
        ) : null
      }
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
      >
        {showPasskey ? (
          <Button
            type="button"
            variant="contained"
            color="primary"
            fullWidth
            startIcon={<KeyRound size={16} aria-hidden="true" />}
            loading={passkey.isPending}
            disabled={locked || busy}
            onClick={() => {
              setNotice(null);
              passkey.mutate();
            }}
          >
            {t('auth:secondFactor.usePasskey')}
          </Button>
        ) : null}

        {showPasskey && showCode ? (
          <Box
            role="separator"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 12,
              color: 'text.secondary',
              '&::before, &::after': {
                content: '""',
                flexGrow: 1,
                height: '1px',
                backgroundColor: tokens['border.default'],
              },
            }}
          >
            {t('auth:secondFactor.orCode')}
          </Box>
        ) : null}

        {showCode ? (
          <Field
            id={fieldId}
            label={recoveryMode ? t('auth:totp.recoveryCodeLabel') : t('auth:totp.codeLabel')}
            hint={hint}
          >
            <OutlinedInput
              id={fieldId}
              value={code}
              onChange={(event) => {
                onCodeChange(event.target.value);
              }}
              disabled={locked}
              fullWidth
              sx={{
                height: 52,
                '& input': {
                  ...monoFontStyle,
                  fontSize: 20,
                  textAlign: 'center',
                  letterSpacing: recoveryMode ? '0.08em' : '0.4em',
                },
              }}
              slotProps={{
                input: {
                  dir: 'ltr',
                  inputMode: recoveryMode ? 'text' : 'numeric',
                  autoComplete: recoveryMode ? 'off' : 'one-time-code',
                  autoFocus: !withPasskey,
                  maxLength: recoveryMode ? 32 : TOTP_LENGTH,
                  'aria-describedby': fieldDescribedBy(fieldId, { hint }),
                },
              }}
            />
          </Field>
        ) : null}

        {recoveryMode ? null : (
          <FormControlLabel
            control={
              <Checkbox
                checked={trustDevice}
                onChange={(event) => {
                  setTrustDevice(event.target.checked);
                }}
              />
            }
            label={t('auth:totp.trustBrowser')}
          />
        )}

        {showCode ? (
          <Button
            type="submit"
            variant={showPasskey ? 'outlined' : 'contained'}
            color="primary"
            fullWidth
            loading={verify.isPending}
            disabled={!ready || locked || passkey.isPending}
          >
            {showPasskey ? t('auth:secondFactor.submitCode') : t('auth:totp.submit')}
          </Button>
        ) : null}

        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
          <Link component="button" type="button" variant="caption" onClick={toggleRecoveryMode}>
            {recoveryMode
              ? factors.totp
                ? t('auth:totp.useAuthenticator')
                : t('auth:secondFactor.usePasskey')
              : t('auth:totp.useRecoveryCode')}
          </Link>
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      </Box>
    </AuthLayout>
  );
}

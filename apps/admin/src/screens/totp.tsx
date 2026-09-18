import { Box, Button, Checkbox, FormControlLabel, Link, OutlinedInput } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Navigate, Link as RouterLink, useLocation, useNavigate } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES, safeReturnTo } from '../app/route-paths.js';
import { isAuthError } from '../auth/api.js';
import { useAuthApi, useSetSession } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../ui/field.tsx';
import { AuthLayout } from './auth-layout.tsx';

/** What `SignIn` hands over when the api asks for a second factor. */
export interface TotpChallengeState {
  readonly challengeId: string;
  readonly email: string;
  readonly returnTo?: string;
}

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
    case 'totp-locked':
      return { message: t('auth:totp.locked'), locked: true };
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

/** The artboard `Admin/TOTP`, including the recovery-code mode it toggles into. */
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

  const challenge = isChallengeState(location.state) ? location.state : null;

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

  // Reaching this screen without a challenge means a reload or a pasted URL;
  // there is nothing to verify, so it starts over rather than showing a form
  // that cannot succeed.
  if (!challenge) {
    return <Navigate to={ROUTES.signIn} replace />;
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!failure?.locked) {
      verify.mutate();
    }
  };

  const toggleRecoveryMode = (): void => {
    setRecoveryMode((current) => !current);
    setCode('');
    setFailure(null);
  };

  const onCodeChange = (value: string): void => {
    // The authenticator code is six digits, so the field only accepts six
    // digits: an invalid state the user cannot reach needs no error message.
    setCode(recoveryMode ? value : value.replace(/\D/g, '').slice(0, TOTP_LENGTH));
  };

  const fieldId = 'totp-code';
  const ready = recoveryMode ? code.trim().length > 0 : code.length === TOTP_LENGTH;
  const hint = recoveryMode ? t('auth:totp.recoveryCodeHint') : t('auth:totp.rotationHint');

  return (
    <AuthLayout
      width={520}
      title={t('auth:totp.title')}
      subtitle={
        recoveryMode
          ? t('auth:totp.recoverySubtitle')
          : t('auth:totp.subtitle', { email: challenge.email })
      }
      footer={failure ? <AlertBanner tone="danger">{failure.message}</AlertBanner> : null}
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
      >
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
            disabled={failure?.locked ?? false}
            fullWidth
            sx={{
              height: 52,
              '& input': {
                fontFamily: (theme) => theme.typography.mono.fontFamily,
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
                autoFocus: true,
                maxLength: recoveryMode ? 32 : TOTP_LENGTH,
                'aria-describedby': fieldDescribedBy(fieldId, { hint }),
              },
            }}
          />
        </Field>

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

        <Button
          type="submit"
          variant="contained"
          color="primary"
          fullWidth
          loading={verify.isPending}
          disabled={!ready || (failure?.locked ?? false)}
        >
          {t('auth:totp.submit')}
        </Button>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
          <Link component="button" type="button" variant="caption" onClick={toggleRecoveryMode}>
            {recoveryMode ? t('auth:totp.useAuthenticator') : t('auth:totp.useRecoveryCode')}
          </Link>
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      </Box>
    </AuthLayout>
  );
}

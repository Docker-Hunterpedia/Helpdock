import { PASSWORD_MIN_LENGTH } from '@helpdock/schemas';
import { Box, Button, Link, OutlinedInput } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  Navigate,
  Link as RouterLink,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES } from '../app/route-paths.js';
import { isAuthError } from '../auth/api.js';
import { useAuthApi } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../ui/field.tsx';
import { AuthLayout } from './auth-layout.tsx';

/**
 * The two halves of a password reset, both built from the `Admin/Login`
 * artboard: the same centred card, one field and one primary button. Neither
 * needs a layout the artboard does not already describe, so neither gets a new
 * one (AGENTS.md, design first).
 */

interface RequestState {
  readonly email: string;
}

const isRequestState = (state: unknown): state is RequestState =>
  typeof state === 'object' && state !== null && typeof (state as RequestState).email === 'string';

/** Confirmation after "Forgot password?", with a way to ask again. */
export function PasswordResetSent(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const location = useLocation();

  const state = isRequestState(location.state) ? location.state : null;

  const resend = useMutation({
    mutationFn: () => api.requestPasswordReset(state?.email ?? ''),
  });

  if (!state) {
    return <Navigate to={ROUTES.signIn} replace />;
  }

  return (
    <AuthLayout
      title={t('auth:passwordReset.sentTitle')}
      subtitle={t('auth:passwordReset.sentSubtitle', { email: state.email })}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {resend.isError ? <AlertBanner tone="danger">{t('auth:unavailable')}</AlertBanner> : null}
        {resend.isSuccess ? (
          <AlertBanner tone="info">{t('auth:passwordReset.resent')}</AlertBanner>
        ) : null}

        <Button
          type="button"
          variant="outlined"
          color="secondary"
          fullWidth
          loading={resend.isPending}
          loadingPosition="start"
          startIcon={<MailCheck size={16} aria-hidden="true" />}
          onClick={() => {
            resend.mutate();
          }}
        >
          {t('auth:passwordReset.resend')}
        </Button>

        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      </Box>
    </AuthLayout>
  );
}

/** The link's destination: one password field, and the token from the query string. */
export function PasswordReset(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [tooShort, setTooShort] = useState(false);

  const reset = useMutation({
    mutationFn: () => api.resetPassword(token, password),
    onSuccess: () => {
      void navigate(ROUTES.signIn, { replace: true, state: { passwordReset: true } });
    },
  });

  // A reset screen with no token cannot do anything, so it starts over rather
  // than showing a form that is guaranteed to fail.
  if (token === '') {
    return <Navigate to={ROUTES.signIn} replace />;
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const short = password.length < PASSWORD_MIN_LENGTH;
    setTooShort(short);
    if (!short) {
      reset.mutate();
    }
  };

  const fieldId = 'password-reset-password';
  const error = tooShort ? t('auth:passwordReset.passwordTooShort') : undefined;
  const hint = t('auth:passwordReset.passwordHint');
  const failed = reset.isError
    ? isAuthError(reset.error) && reset.error.code === 'challenge-expired'
      ? t('auth:passwordReset.invalid')
      : t('auth:unavailable')
    : undefined;

  return (
    <AuthLayout
      title={t('auth:passwordReset.title')}
      subtitle={t('auth:passwordReset.subtitle')}
      footer={
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      }
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
      >
        {failed ? <AlertBanner tone="danger">{failed}</AlertBanner> : null}

        <Field id={fieldId} label={t('auth:passwordReset.passwordLabel')} hint={hint} error={error}>
          <OutlinedInput
            id={fieldId}
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            error={Boolean(error)}
            fullWidth
            slotProps={{
              input: {
                dir: 'ltr',
                autoComplete: 'new-password',
                autoFocus: true,
                'aria-describedby': fieldDescribedBy(fieldId, { hint, error }),
              },
            }}
          />
        </Field>

        <Button
          type="submit"
          variant="contained"
          color="primary"
          fullWidth
          loading={reset.isPending}
        >
          {t('auth:passwordReset.submit')}
        </Button>
      </Box>
    </AuthLayout>
  );
}

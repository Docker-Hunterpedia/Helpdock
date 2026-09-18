import { Box, Button, Divider, Link, OutlinedInput, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useT } from '../app/i18n.js';
import { RETURN_TO_PARAM, ROUTES, safeReturnTo } from '../app/route-paths.js';
import type { AuthApi } from '../auth/api.js';
import { isAuthError } from '../auth/api.js';
import type { AuthErrorCode, OauthProvider } from '../auth/schemas.js';
import { useAuthApi, useSetSession } from '../auth/session.tsx';
import { readPublicInstallInfo } from '../install/public-info.js';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../ui/field.tsx';
import { ProviderMark } from '../ui/provider-marks.tsx';
import { AuthLayout, LanguageLink } from './auth-layout.tsx';
import { type SignInFormErrors, validateEmail, validateSignInForm } from './sign-in-form.js';

const EMAIL_ERROR_KEYS = {
  required: 'auth:signIn.emailRequired',
  invalid: 'auth:signIn.emailInvalid',
} as const;

const OAUTH_PROVIDERS = [
  { provider: 'google', labelKey: 'auth:signIn.google' },
  { provider: 'github', labelKey: 'auth:signIn.github' },
] as const satisfies readonly { provider: OauthProvider; labelKey: string }[];

function ProviderButtons({ api }: { readonly api: AuthApi }): ReactNode {
  const t = useT();

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
      {OAUTH_PROVIDERS.map(({ provider, labelKey }) => (
        <Button
          key={provider}
          component="a"
          href={api.oauthStartUrl(provider)}
          variant="outlined"
          color="secondary"
          startIcon={<ProviderMark name={provider} />}
        >
          {t(labelKey)}
        </Button>
      ))}
    </Box>
  );
}

/** The artboards `Admin/Login` and `Admin/Login-AR`. */
export function SignIn(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get(RETURN_TO_PARAM));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<SignInFormErrors>({});
  const [failure, setFailure] = useState<AuthErrorCode | null>(null);

  const install = useMemo(() => readPublicInstallInfo(), []);

  const signIn = useMutation({
    mutationFn: () => api.signInWithPassword(email.trim(), password),
    onSuccess: (result) => {
      if (result.kind === 'session') {
        setSession(result.session);
        void navigate(returnTo, { replace: true });
        return;
      }

      void navigate(ROUTES.totp, {
        state: { challengeId: result.challengeId, email: result.email, returnTo },
      });
    },
    onError: (error: unknown) => {
      setFailure(isAuthError(error) ? error.code : 'unavailable');
    },
  });

  const magicLink = useMutation({
    mutationFn: () => api.requestMagicLink(email.trim()),
    onSuccess: () => {
      void navigate(ROUTES.magicLinkSent, { state: { email: email.trim() } });
    },
    onError: () => {
      setFailure('unavailable');
    },
  });

  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = validateSignInForm({ email, password });
    setErrors(found);
    setFailure(null);

    if (Object.keys(found).length === 0) {
      signIn.mutate();
    }
  };

  const submitMagicLink = (): void => {
    const emailIssue = validateEmail(email);
    setErrors(emailIssue ? { email: emailIssue } : {});
    setFailure(null);

    if (!emailIssue) {
      magicLink.mutate();
    }
  };

  const subtitle =
    install.brandCount > 1
      ? t('auth:signIn.subtitle', { domain: install.primaryDomain, count: install.brandCount - 1 })
      : t('auth:signIn.subtitleSingleBrand', { domain: install.primaryDomain });

  const emailError = errors.email ? t(EMAIL_ERROR_KEYS[errors.email]) : undefined;
  const passwordError = errors.password ? t('auth:signIn.passwordRequired') : undefined;
  const failureMessage =
    failure === 'invalid-credentials'
      ? t('auth:signIn.invalidCredentials')
      : failure
        ? t('auth:unavailable')
        : undefined;

  return (
    <AuthLayout
      title={t('auth:signIn.title')}
      subtitle={subtitle}
      footer={
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('auth:signIn.twoFactorRequired')}
          </Typography>
          <LanguageLink />
        </Box>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {failureMessage ? <AlertBanner tone="danger">{failureMessage}</AlertBanner> : null}

        <Box
          component="form"
          noValidate
          onSubmit={submitPassword}
          sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
        >
          <Field id="sign-in-email" label={t('auth:signIn.emailLabel')} error={emailError}>
            <OutlinedInput
              id="sign-in-email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              error={Boolean(emailError)}
              fullWidth
              slotProps={{
                input: {
                  dir: 'ltr',
                  autoComplete: 'username',
                  'aria-describedby': fieldDescribedBy('sign-in-email', { error: emailError }),
                },
              }}
            />
          </Field>

          <Field
            id="sign-in-password"
            label={t('auth:signIn.passwordLabel')}
            error={passwordError}
            action={
              // Until M0-05 ships password reset, the recovery path this
              // install has is the sign-in link, so the control does that
              // rather than pointing at a page that does not exist.
              <Link component="button" type="button" variant="caption" onClick={submitMagicLink}>
                {t('auth:signIn.forgotPassword')}
              </Link>
            }
          >
            <OutlinedInput
              id="sign-in-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              error={Boolean(passwordError)}
              fullWidth
              slotProps={{
                input: {
                  dir: 'ltr',
                  autoComplete: 'current-password',
                  'aria-describedby': fieldDescribedBy('sign-in-password', {
                    error: passwordError,
                  }),
                },
              }}
            />
          </Field>

          <Button
            type="submit"
            variant="contained"
            color="primary"
            fullWidth
            loading={signIn.isPending}
            disabled={magicLink.isPending}
          >
            {t('auth:signIn.submit')}
          </Button>
        </Box>

        <Divider>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('auth:signIn.or')}
          </Typography>
        </Divider>

        <Button
          type="button"
          variant="outlined"
          color="secondary"
          fullWidth
          loading={magicLink.isPending}
          loadingPosition="start"
          disabled={signIn.isPending}
          startIcon={<Mail size={16} aria-hidden="true" />}
          onClick={submitMagicLink}
        >
          {t('auth:signIn.magicLink')}
        </Button>

        <ProviderButtons api={api} />
      </Box>
    </AuthLayout>
  );
}

import type { Locale } from '@helpdock/i18n';
import { SUPPORTED_LNGS } from '@helpdock/i18n';
import { type OauthProvider, oauthProviderSchema, PASSWORD_MIN_LENGTH } from '@helpdock/schemas';
import { Box, Button, Divider, Link, MenuItem, TextField, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { DEFAULT_SIGNED_IN_ROUTE, ROUTES } from '../app/route-paths.js';
import { isAuthError } from '../auth/api.js';
import { rememberInviteReturn } from '../auth/invite-return.js';
import { PROVIDER_NAME_KEYS } from '../auth/provider-names.js';
import { useAuthApi, useSetSession } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { PasswordField } from '../ui/password-field.tsx';
import { passwordStrength } from '../ui/password-strength.js';
import { AuthLayout } from './auth-layout.tsx';
import { InviteProviderButtons, useConfiguredProviders } from './invite-providers.tsx';
import { InviteSsoButtons } from './sso-sign-in.tsx';
import { isolate } from './tickets/format.js';

/**
 * `Admin/AcceptInvite`: the one screen somebody without an account ever sees.
 *
 * It is outside the shell, because there is no session to draw a shell with,
 * and outside `RequireSession` for the same reason. The token in the path is
 * the credential; reading it costs nothing, and only the form spends it.
 *
 * The expired state names the person who invited them when the api still knows
 * it, so "ask an administrator" is a name rather than a shrug. When the token
 * is gone entirely there is nobody to name, and the caption says so instead.
 *
 * `Admin/AcceptInvite-Providers` (M18-07) adds the configured providers as a
 * second way to accept: the provider's account, when it is the invited
 * address's, becomes the new account's way in, with no password. When it is
 * not, the callback sends the person back here with the mismatch state, which
 * offers the providers again or the password form.
 */

/** What `/oauth/callback` hands back when the provider account was not the invited one. */
const returnStateSchema = z.object({
  mismatch: z
    .object({
      provider: oauthProviderSchema,
      // From the callback's fragment, which anybody can write: an address or nothing.
      account: z.email().optional().catch(undefined),
    })
    .optional(),
  name: z.string().optional(),
});

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const daysUntil = (iso: string): number =>
  Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / MILLIS_PER_DAY));

export function AcceptInvite(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const navigate = useNavigate();
  const setSession = useSetSession();
  const { locale: appLocale, setLocale } = usePreferences();
  const { token = '' } = useParams<{ token: string }>();
  const location = useLocation();
  const returned = returnStateSchema.safeParse(location.state).data ?? {};
  const providers = useConfiguredProviders();

  const nameId = useId();
  const passwordId = useId();
  const localeId = useId();
  const providersId = useId();

  const [name, setName] = useState(returned.name ?? '');
  const [mismatch, setMismatch] = useState(returned.mismatch);
  const [password, setPassword] = useState('');
  const [locale, setChosenLocale] = useState<Locale>(appLocale);
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});
  const [breached, setBreached] = useState(false);

  const methods = useQuery({ queryKey: ['auth', 'methods'], queryFn: () => api.authMethods() });

  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.previewInvite(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token, { name: name.trim(), password, locale }),
    onError: (error) => {
      setBreached(isAuthError(error) && error.code === 'password-breached');
    },
    onSuccess: (result) => {
      // The language they just chose is the language the app should already be
      // in by the time the next screen paints.
      setLocale(locale);

      if (result.kind === 'session') {
        setSession(result.session);
        void navigate(DEFAULT_SIGNED_IN_ROUTE, { replace: true });
        return;
      }

      // An install that requires two-factor sends them straight to enrolment;
      // the caption under the form already said this was coming.
      void navigate(ROUTES.totpEnrolment, {
        replace: true,
        state: { challengeId: result.challengeId },
      });
    },
  });

  const startWithProvider = useMutation({
    mutationFn: (provider: OauthProvider) =>
      api.startInviteOauth(token, provider, { name: name.trim(), locale }),
    onSuccess: (url) => {
      rememberInviteReturn({ path: location.pathname, name: name.trim() });
      // An app path stays in the router; a provider's address is a page load.
      if (url.startsWith('/')) {
        void navigate(url);
      } else {
        window.location.assign(url);
      }
    },
  });

  const chooseProvider = (provider: OauthProvider): void => {
    if (name.trim() === '') {
      setMismatch(undefined);
      setErrors({ name: t('auth:invite.nameRequired') });
      return;
    }
    setErrors({});
    startWithProvider.mutate(provider);
  };

  const strength = passwordStrength(password);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    const next: { name?: string; password?: string } = {};
    if (name.trim() === '') {
      next.name = t('auth:invite.nameRequired');
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      next.password = t('auth:invite.passwordTooShort', { count: PASSWORD_MIN_LENGTH });
    }

    setErrors(next);
    if (Object.keys(next).length === 0) {
      accept.mutate();
    }
  };

  if (invite.isPending) {
    return (
      <AuthLayout title={t('auth:invite.title')} subtitle={t('auth:invite.loading')} width={440}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('common:loading')}
        </Typography>
      </AuthLayout>
    );
  }

  if (invite.isError || invite.data === undefined) {
    return (
      <AuthLayout
        title={t('auth:invite.expiredTitle')}
        subtitle={t('auth:invite.expiredBodyUnknown')}
        width={440}
      >
        {/* One sentence and one way out, which is the whole of the artboard's
            expired state: there is nothing here to fill in. */}
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link component={RouterLink} to={ROUTES.signIn} variant="body2">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      </AuthLayout>
    );
  }

  const departments =
    invite.data.departments.length === 0
      ? t('auth:invite.allDepartments')
      : invite.data.departments.join(', ');

  return (
    <AuthLayout
      title={t('auth:invite.title')}
      subtitle={t('auth:invite.caption', {
        count: daysUntil(invite.data.expiresAt),
        inviter: invite.data.inviterName,
        email: invite.data.email,
        role: t(`staff:roles.${invite.data.role}`),
        departments,
      })}
      width={440}
      footer={
        <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center' }}>
          {t('auth:invite.next2fa')}
        </Typography>
      }
    >
      <Box
        component="form"
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
      >
        <InviteSsoButtons email={invite.data.email} />
        {!methods.data?.ssoEnforced && mismatch !== undefined ? (
          <>
            <AlertBanner tone="danger">
              {mismatch.account === undefined
                ? t('auth:invite.providers.mismatchUnnamed', {
                    provider: t(PROVIDER_NAME_KEYS[mismatch.provider]),
                    email: isolate(invite.data.email),
                  })
                : t('auth:invite.providers.mismatch', {
                    provider: t(PROVIDER_NAME_KEYS[mismatch.provider]),
                    account: isolate(mismatch.account),
                    email: isolate(invite.data.email),
                  })}
            </AlertBanner>
            <InviteProviderButtons
              providers={providers}
              busy={startWithProvider.isPending}
              onChoose={chooseProvider}
            />
            <Divider>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('auth:signIn.or')}
              </Typography>
            </Divider>
            <Button
              type="button"
              variant="outlined"
              color="secondary"
              onClick={() => {
                setMismatch(undefined);
              }}
            >
              {t('auth:invite.providers.choosePassword')}
            </Button>
          </>
        ) : null}
        {!methods.data?.ssoEnforced && mismatch === undefined ? (
          <>
            {(accept.isError && !breached) || startWithProvider.isError ? (
              <AlertBanner tone="danger">{t('auth:unavailable')}</AlertBanner>
            ) : null}

            <TextField
              id={nameId}
              label={t('auth:invite.nameLabel')}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              error={errors.name !== undefined}
              helperText={errors.name ?? ' '}
              slotProps={{ htmlInput: { autoComplete: 'name', maxLength: 120 } }}
            />

            {providers.length > 0 ? (
              <Box
                role="group"
                aria-labelledby={providersId}
                sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
              >
                <Typography id={providersId} variant="bodyStrong" component="p">
                  {t('auth:invite.providers.label')}
                </Typography>
                <InviteProviderButtons
                  providers={providers}
                  busy={startWithProvider.isPending}
                  onChoose={chooseProvider}
                />
                <Divider>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('auth:invite.providers.orPassword')}
                  </Typography>
                </Divider>
              </Box>
            ) : null}

            <PasswordField
              id={passwordId}
              label={t('auth:invite.passwordLabel')}
              value={password}
              onChange={(value) => {
                setPassword(value);
                setBreached(false);
              }}
              hint={t('auth:invite.passwordHint', {
                count: PASSWORD_MIN_LENGTH,
                strength: t(`auth:invite.strength.${strength.level}`),
              })}
              refusal={
                errors.password !== undefined
                  ? { kind: 'short', message: errors.password }
                  : breached
                    ? { kind: 'breached' }
                    : null
              }
            />

            <TextField
              id={localeId}
              select
              label={t('auth:invite.localeLabel')}
              value={locale}
              onChange={(event) => {
                setChosenLocale(event.target.value as Locale);
              }}
            >
              {SUPPORTED_LNGS.map((option) => (
                <MenuItem key={option} value={option} lang={option}>
                  {t(`common:language.${option}`)}
                </MenuItem>
              ))}
            </TextField>

            <Button type="submit" variant="contained" disabled={accept.isPending}>
              {t('auth:invite.submit')}
            </Button>
          </>
        ) : null}
      </Box>
    </AuthLayout>
  );
}

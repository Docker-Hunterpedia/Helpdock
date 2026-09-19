import type { Locale } from '@helpdock/i18n';
import { SUPPORTED_LNGS } from '@helpdock/i18n';
import { PASSWORD_MIN_LENGTH } from '@helpdock/schemas';
import { Box, Button, Link, MenuItem, TextField, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';
import { useT } from '../app/i18n.js';
import { usePreferences } from '../app/providers.tsx';
import { DEFAULT_SIGNED_IN_ROUTE, ROUTES } from '../app/route-paths.js';
import { useAuthApi, useSetSession } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { passwordStrength } from '../ui/password-strength.js';
import { PasswordStrengthBar } from '../ui/password-strength-bar.tsx';
import { AuthLayout } from './auth-layout.tsx';

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
 */

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

  const nameId = useId();
  const passwordId = useId();
  const localeId = useId();

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [locale, setChosenLocale] = useState<Locale>(appLocale);
  const [errors, setErrors] = useState<{ name?: string; password?: string }>({});

  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.previewInvite(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const accept = useMutation({
    mutationFn: () => api.acceptInvite(token, { name: name.trim(), password, locale }),
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
      void navigate(ROUTES.totpEnrolment, { replace: true });
    },
  });

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
        {accept.isError ? <AlertBanner tone="danger">{t('auth:unavailable')}</AlertBanner> : null}

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

        <Box>
          <TextField
            id={passwordId}
            type="password"
            label={t('auth:invite.passwordLabel')}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            error={errors.password !== undefined}
            helperText={
              errors.password ??
              t('auth:invite.passwordHint', {
                count: PASSWORD_MIN_LENGTH,
                strength: t(`auth:invite.strength.${strength.level}`),
              })
            }
            fullWidth
            slotProps={{ htmlInput: { autoComplete: 'new-password', maxLength: 200 } }}
          />
          <PasswordStrengthBar strength={strength} />
        </Box>

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
      </Box>
    </AuthLayout>
  );
}

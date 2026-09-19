import { oauthProviderSchema } from '@helpdock/schemas';
import { Box, CircularProgress, Link, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { Navigate, Link as RouterLink, useSearchParams } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES } from '../app/route-paths.js';
import { useAuthApi, useSetSession } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { AuthLayout } from './auth-layout.tsx';

/**
 * Where a magic link and an OAuth callback land. The api has already done the
 * work and redirected here with one of four things in the query string:
 *
 * | | |
 * |---|---|
 * | `code` | A one-time code to exchange for the session. The access token never travels in a URL (DOMAIN-RULES §4.6). |
 * | `challenge` | The second factor still has to be answered, so this hands over to the code screen. |
 * | `enrol` | The install requires 2FA and this account has none yet. |
 * | `error` | Nothing worked; say so and offer the way back. |
 *
 * One screen for both routes because the four cases are identical either way;
 * the provider's name is only ever used to word the caption.
 */

const PROVIDER_LABELS = {
  google: 'auth:signIn.google',
  github: 'auth:signIn.github',
} as const;

export function AuthComplete(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const setSession = useSetSession();
  const [searchParams] = useSearchParams();

  const code = searchParams.get('code');
  const challenge = searchParams.get('challenge');
  const enrol = searchParams.get('enrol');
  const failure = searchParams.get('error');

  const provider = oauthProviderSchema.safeParse(searchParams.get('provider'));

  const exchange = useMutation({
    mutationFn: (value: string) => api.exchange(value),
    onSuccess: (session) => {
      setSession(session);
    },
  });

  const { mutate } = exchange;
  useEffect(() => {
    if (code !== null) {
      mutate(code);
    }
  }, [code, mutate]);

  if (exchange.isSuccess) {
    return <Navigate to={ROUTES.tickets} replace />;
  }

  if (challenge !== null) {
    return (
      <Navigate
        to={ROUTES.totp}
        replace
        state={{ challengeId: challenge, email: searchParams.get('email') ?? '' }}
      />
    );
  }

  if (enrol !== null) {
    return <Navigate to={ROUTES.totpEnrolment} replace />;
  }

  const failed = failure !== null || exchange.isError;
  const subtitle = provider.success
    ? t('auth:oauth.body', { provider: t(PROVIDER_LABELS[provider.data]) })
    : t('auth:completing.body');

  return (
    <AuthLayout
      title={provider.success ? t('auth:oauth.title') : t('auth:completing.title')}
      subtitle={subtitle}
      footer={
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      }
    >
      {failed ? (
        <AlertBanner tone="danger">
          {failure === 'no-account' ? t('auth:noAccount') : t('auth:completing.failed')}
        </AlertBanner>
      ) : (
        <Box
          role="status"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            padding: 4,
          }}
        >
          <CircularProgress size={16} aria-hidden="true" />
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('common:loading')}
          </Typography>
        </Box>
      )}
    </AuthLayout>
  );
}

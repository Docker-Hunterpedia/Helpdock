import { oauthProviderSchema } from '@helpdock/schemas';
import { Box, CircularProgress, Link, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef } from 'react';
import { Navigate, Link as RouterLink, useLocation, useSearchParams } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES, safeReturnTo } from '../app/route-paths.js';
import { takeInviteReturn } from '../auth/invite-return.js';
import { oauthErrorKey } from '../auth/oauth-error.js';
import { PROVIDER_NAME_KEYS } from '../auth/provider-names.js';
import { useAuthApi, useSetSession } from '../auth/session.tsx';
import { ssoErrorKey } from '../auth/sso-error.js';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { AuthLayout } from './auth-layout.tsx';
import { isOauthRefusal, OauthRefusal } from './oauth-refusal.tsx';

/**
 * Where an SSO sign-in and an OAuth callback land. The api has already done the
 * work and redirected here with one of four things in the query string:
 *
 * | | |
 * |---|---|
 * | `code` | A one-time code to exchange for the session. The access token never travels in a URL (DOMAIN-RULES §4.6). |
 * | `challenge` | The second factor still has to be answered, so this hands over to the code screen. |
 * | `enrol` | The install requires 2FA and this account has none yet. |
 * | `error` | Nothing worked; say so and offer the way back. An OAuth refusal with something to explain (`oauth-link-required`, `oauth-domain-not-allowed`, `oauth-tenant-mismatch`) gets the `Admin/Login-Providers` card instead. |
 *
 * One screen for both routes because the four cases are identical either way;
 * the provider's name is only ever used to word the caption.
 */

/** The provider account answered an invitation for another address (M18-07). */
const INVITE_MISMATCH = 'oauth-invite-mismatch';

/** The callback puts the provider's address in the fragment, which no server log sees. */
const accountFromFragment = (hash: string): string =>
  new URLSearchParams(hash.slice(1)).get('account') ?? '';

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

  const exchangedCode = useRef<string | null>(null);
  const location = useLocation();
  // Read once: the invite screen it points back to is this tab's to return to.
  const inviteReturn = useRef(failure === INVITE_MISMATCH ? takeInviteReturn() : null);
  const { mutate } = exchange;
  useEffect(() => {
    if (code !== null && exchangedCode.current !== code) {
      // One-time credentials must survive React's development effect replay.
      exchangedCode.current = code;
      mutate(code);
    }
  }, [code, mutate]);

  if (exchange.isSuccess) {
    return <Navigate to={safeReturnTo(searchParams.get('returnTo'))} replace />;
  }

  if (challenge !== null) {
    return (
      <Navigate
        to={ROUTES.totp}
        replace
        state={{
          challengeId: challenge,
          email: searchParams.get('email') ?? '',
          returnTo: safeReturnTo(searchParams.get('returnTo')),
        }}
      />
    );
  }

  if (enrol !== null) {
    return (
      <Navigate
        to={ROUTES.totpEnrolment}
        replace
        state={{ challengeId: enrol, returnTo: safeReturnTo(searchParams.get('returnTo')) }}
      />
    );
  }

  if (isOauthRefusal(failure) && provider.success) {
    return <OauthRefusal code={failure} provider={provider.data} />;
  }

  if (failure === INVITE_MISMATCH && provider.success && inviteReturn.current !== null) {
    return (
      <Navigate
        to={inviteReturn.current.path}
        replace
        state={{
          name: inviteReturn.current.name,
          mismatch: { provider: provider.data, account: accountFromFragment(location.hash) },
        }}
      />
    );
  }

  const ssoFailure = ssoErrorKey(failure);
  const oauthFailure = oauthErrorKey(failure);
  const failed = failure !== null || exchange.isError;
  const subtitle = provider.success
    ? t('auth:oauth.body', { provider: t(PROVIDER_NAME_KEYS[provider.data]) })
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
          {ssoFailure
            ? t(ssoFailure)
            : oauthFailure
              ? t(oauthFailure)
              : failure === INVITE_MISMATCH
                ? t('auth:invite.providers.mismatchLost', {
                    provider: provider.success ? t(PROVIDER_NAME_KEYS[provider.data]) : '',
                  })
                : failure === 'invite-expired'
                  ? t('auth:invite.providers.expired')
                  : failure === 'no-account'
                    ? t('auth:noAccount')
                    : t('auth:completing.failed')}
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

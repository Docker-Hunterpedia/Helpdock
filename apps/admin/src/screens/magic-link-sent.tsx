import { Box, Button, Link } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, Link as RouterLink, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES } from '../app/route-paths.js';
import { useAuthApi } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { AuthLayout } from './auth-layout.tsx';

interface MagicLinkState {
  readonly email: string;
}

const isMagicLinkState = (state: unknown): state is MagicLinkState =>
  typeof state === 'object' &&
  state !== null &&
  typeof (state as MagicLinkState).email === 'string';

/** Confirmation after "Email me a sign-in link", with a way to ask again. */
export function MagicLinkSent(): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const location = useLocation();

  const state = isMagicLinkState(location.state) ? location.state : null;

  const resend = useMutation({
    mutationFn: () => api.requestMagicLink(state?.email ?? ''),
  });

  if (!state) {
    return <Navigate to={ROUTES.signIn} replace />;
  }

  return (
    <AuthLayout
      title={t('auth:magicLink.title')}
      subtitle={t('auth:magicLink.subtitle', { email: state.email })}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {resend.isError ? <AlertBanner tone="danger">{t('auth:unavailable')}</AlertBanner> : null}
        {resend.isSuccess ? (
          <AlertBanner tone="info">{t('auth:magicLink.resent')}</AlertBanner>
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
          {t('auth:magicLink.resend')}
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

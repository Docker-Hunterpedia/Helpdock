import { Box, Link } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES } from '../app/route-paths.js';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { AuthLayout } from './auth-layout.tsx';

/**
 * Where an install with `auth.require2fa` on sends an account that has no
 * authenticator yet.
 *
 * It is deliberately a dead end. The api already has the enrolment endpoints —
 * `POST /api/auth/totp/enrol` and `/confirm` — and M0-06 builds the profile
 * screen with the QR code that uses them. Sending someone to a page that says
 * so is better than sending them back to a sign-in form that will refuse them
 * again for a reason it cannot explain.
 */
export function TotpEnrolment(): ReactNode {
  const t = useT();

  return (
    <AuthLayout
      title={t('auth:enrolment.title')}
      subtitle={t('auth:enrolment.subtitle')}
      footer={
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      }
    >
      <AlertBanner tone="info">{t('auth:enrolment.body')}</AlertBanner>
    </AuthLayout>
  );
}

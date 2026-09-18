import { Box, CircularProgress, Link, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES } from '../app/route-paths.js';
import { oauthProviderSchema } from '../auth/schemas.js';
import { AuthLayout } from './auth-layout.tsx';

const PROVIDER_LABELS = {
  google: 'auth:signIn.google',
  github: 'auth:signIn.github',
} as const;

/**
 * Where the provider sends the browser back to. M0-05 (#8) exchanges the code
 * here; until then the route exists so the two provider buttons land somewhere
 * that explains itself instead of a blank 404.
 */
export function OAuthCallback(): ReactNode {
  const t = useT();
  const [searchParams] = useSearchParams();
  const parsed = oauthProviderSchema.safeParse(searchParams.get('provider'));
  const provider = parsed.success ? t(PROVIDER_LABELS[parsed.data]) : '';

  return (
    <AuthLayout
      title={t('auth:oauth.title')}
      subtitle={t('auth:oauth.body', { provider })}
      footer={
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link component={RouterLink} to={ROUTES.signIn} variant="caption">
            {t('auth:backToSignIn')}
          </Link>
        </Box>
      }
    >
      <Box
        role="status"
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, padding: 4 }}
      >
        <CircularProgress size={16} aria-hidden="true" />
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('common:loading')}
        </Typography>
      </Box>
    </AuthLayout>
  );
}

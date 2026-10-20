import type { OauthProvider } from '@helpdock/schemas';
import { Box, Button, Paper, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../app/i18n.js';
import { ROUTES } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { PROVIDER_NAME_KEYS } from '../auth/provider-names.js';
import { BrandMark } from '../ui/brand-mark.tsx';

/**
 * The OAuth callback refusals with a screen of their own (`Admin/Login-Providers`,
 * M18-07): one card with the mark, a heading, one paragraph, the steps when
 * there is something to do, and one way back. Neither says whether an account
 * with the provider's address exists.
 */

export const OAUTH_REFUSALS = [
  'oauth-link-required',
  'oauth-domain-not-allowed',
  'oauth-tenant-mismatch',
] as const;
export type OauthRefusalCode = (typeof OAUTH_REFUSALS)[number];

export const isOauthRefusal = (code: string | null): code is OauthRefusalCode =>
  (OAUTH_REFUSALS as readonly (string | null)[]).includes(code);

export function OauthRefusal({
  code,
  provider,
}: {
  readonly code: OauthRefusalCode;
  readonly provider: OauthProvider;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const values = { provider: t(PROVIDER_NAME_KEYS[provider]) };
  const steps =
    code === 'oauth-link-required'
      ? [
          t('auth:oauth.refusals.oauth-link-required.steps.signIn'),
          t('auth:oauth.refusals.oauth-link-required.steps.open'),
          t('auth:oauth.refusals.oauth-link-required.steps.connect', values),
        ]
      : [];

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        backgroundColor: tokens['bg.canvas'],
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 6,
      }}
    >
      <Paper
        elevation={0}
        component="section"
        sx={{
          width: '100%',
          maxWidth: 440,
          padding: 6,
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <BrandMark initial="H" size={32} />
          <Typography variant="h3" component="p">
            {t('common:appName')}
          </Typography>
        </Box>
        <Typography variant="h2" component="h1" sx={{ textWrap: 'pretty' }}>
          {t(`auth:oauth.refusals.${code}.title`, values)}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t(`auth:oauth.refusals.${code}.body`, values)}
        </Typography>
        {steps.length > 0 ? (
          <Box
            component="ol"
            sx={{
              margin: 0,
              paddingInlineStart: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              color: tokens['text.primary'],
            }}
          >
            {steps.map((step) => (
              <Typography key={step} component="li" variant="body2">
                {step}
              </Typography>
            ))}
          </Box>
        ) : null}
        <Button component={RouterLink} to={ROUTES.signIn} variant="contained" fullWidth>
          {t('auth:backToSignIn')}
        </Button>
      </Paper>
    </Box>
  );
}

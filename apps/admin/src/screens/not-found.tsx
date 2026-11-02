import { Box, Button, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { DEFAULT_SIGNED_IN_ROUTE, legacyRedirect } from '../app/route-paths.js';
import { useSemanticTokens } from '../app/tokens.js';
import { usePageTitle } from '../shell/page-title.js';

/**
 * A signed-in address that leads nowhere (`Admin/UX-Fixes-2026-11`). An address
 * from before the Settings area still redirects first, and the bare `/` keeps
 * opening the default screen.
 */
export function NotFoundOrRedirect(): ReactNode {
  const { pathname, search, hash } = useLocation();
  const redirect = legacyRedirect(pathname, search, hash);
  if (redirect !== null) {
    return <Navigate to={redirect} replace />;
  }
  if (pathname === '/') {
    return <Navigate to={DEFAULT_SIGNED_IN_ROUTE} replace />;
  }
  return <NotFoundPage />;
}

function NotFoundPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  usePageTitle(t('admin:notFound.title'));

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        textAlign: 'center',
        paddingBlock: 16,
        paddingInline: 6,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h1" component="h1">
        {t('admin:notFound.title')}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 420 }}>
        {t('admin:notFound.body')}
      </Typography>
      <Button component={Link} to={DEFAULT_SIGNED_IN_ROUTE} variant="contained">
        {t('admin:notFound.action')}
      </Button>
    </Box>
  );
}

import { Box, CircularProgress } from '@mui/material';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useT } from '../app/i18n.js';
import { RETURN_TO_PARAM, ROUTES } from '../app/route-paths.js';
import { RealtimeProvider } from '../realtime/realtime-provider.tsx';
import { SessionProvider, useSessionQuery } from './session.tsx';

/**
 * The gate every signed-in route sits behind. While `me()` is in flight it
 * shows nothing but a busy indicator: redirecting first and correcting later
 * would bounce a signed-in user through the sign-in screen on every reload.
 */
export function RequireSession(): ReactNode {
  const t = useT();
  const { data: session, isPending } = useSessionQuery();
  const location = useLocation();

  if (isPending) {
    return (
      <Box
        role="status"
        aria-label={t('common:loading')}
        sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}
      >
        <CircularProgress aria-hidden="true" />
      </Box>
    );
  }

  if (!session) {
    const returnTo = `${location.pathname}${location.search}`;
    const query = new URLSearchParams({ [RETURN_TO_PARAM]: returnTo });

    return <Navigate to={`${ROUTES.signIn}?${query.toString()}`} replace />;
  }

  return (
    <SessionProvider session={session}>
      {/* Below the session, because a socket needs a principal, a brand and a
          token, and none of the three exists on the sign-in screen (M0-13). */}
      <RealtimeProvider>
        <Outlet />
      </RealtimeProvider>
    </SessionProvider>
  );
}

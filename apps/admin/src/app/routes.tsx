import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { RequireSession } from '../auth/require-session.tsx';
import { AuthComplete } from '../screens/auth-complete.tsx';
import { MagicLinkSent } from '../screens/magic-link-sent.tsx';
import { PasswordReset, PasswordResetSent } from '../screens/password-reset.tsx';
import { PlaceholderPage } from '../screens/placeholder-page.tsx';
import { SignIn } from '../screens/sign-in.tsx';
import { Totp } from '../screens/totp.tsx';
import { TotpEnrolment } from '../screens/totp-enrolment.tsx';
import { AppShell } from '../shell/app-shell.tsx';
import { ALL_NAV } from '../shell/nav-items.js';
import { DEFAULT_SIGNED_IN_ROUTE, ROUTES } from './route-paths.js';

/**
 * Two groups: the public auth screens, and everything else behind
 * `RequireSession` inside the shell. An unknown path goes to the default
 * screen, which redirects to sign-in when there is no session.
 *
 * `AuthComplete` is mounted twice because the api redirects a magic link and an
 * OAuth callback to different paths and the screen handles both the same way.
 */
export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route path={ROUTES.signIn} element={<SignIn />} />
      <Route path={ROUTES.totp} element={<Totp />} />
      <Route path={ROUTES.magicLinkSent} element={<MagicLinkSent />} />
      <Route path={ROUTES.authComplete} element={<AuthComplete />} />
      <Route path={ROUTES.oauthCallback} element={<AuthComplete />} />
      <Route path={ROUTES.passwordResetSent} element={<PasswordResetSent />} />
      <Route path={ROUTES.passwordReset} element={<PasswordReset />} />
      <Route path={ROUTES.totpEnrolment} element={<TotpEnrolment />} />

      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          {ALL_NAV.map((item) => (
            <Route
              key={item.key}
              path={item.path}
              element={<PlaceholderPage navKey={item.key} />}
            />
          ))}
        </Route>
      </Route>

      <Route path="*" element={<Navigate to={DEFAULT_SIGNED_IN_ROUTE} replace />} />
    </Routes>
  );
}

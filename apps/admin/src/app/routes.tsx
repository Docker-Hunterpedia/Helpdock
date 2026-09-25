import { type ReactNode, useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { RequireSession } from '../auth/require-session.tsx';
import { readPublicInstallInfo } from '../install/public-info.js';
import { AcceptInvite } from '../screens/accept-invite.tsx';
import { SystemPage } from '../screens/admin/system/system-page.tsx';
import { SystemQueuesPage } from '../screens/admin/system/system-queues-page.tsx';
import { TicketingPage } from '../screens/admin/ticketing/ticketing-page.tsx';
import { AuthComplete } from '../screens/auth-complete.tsx';
import { AccountPage } from '../screens/contacts/account-page.tsx';
import { ContactPage } from '../screens/contacts/contact-page.tsx';
import { ContactsPage } from '../screens/contacts/contacts-page.tsx';
import { NewContactPage } from '../screens/contacts/new-contact-page.tsx';
import { MagicLinkSent } from '../screens/magic-link-sent.tsx';
import { PasswordReset, PasswordResetSent } from '../screens/password-reset.tsx';
import { PlaceholderPage } from '../screens/placeholder-page.tsx';
import { SecurityScreen } from '../screens/security.tsx';
import { SetupPage } from '../screens/setup/setup-page.tsx';
import { SignIn } from '../screens/sign-in.tsx';
import { StaffScreen } from '../screens/staff.tsx';
import { TicketsPage } from '../screens/tickets/tickets-page.tsx';
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
 *
 * `/invite/:token` is public for the same reason the sign-in screens are: the
 * token in the path is the credential, and somebody following it has no session
 * to require.
 *
 * A **fresh install has one screen**: nobody can sign in to an install with no
 * accounts in it, so every path goes to the wizard until it has been finished
 * (M0-08). On a configured install `/setup` is not a route at all, and the
 * catch-all below sends it where every other unknown path goes.
 */
export function AppRoutes(): ReactNode {
  const install = useMemo(() => readPublicInstallInfo(), []);

  if (install.installState === 'fresh') {
    return (
      <Routes>
        <Route path={ROUTES.setup} element={<SetupPage />} />
        <Route path="*" element={<Navigate to={ROUTES.setup} replace />} />
      </Routes>
    );
  }

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
      <Route path={ROUTES.acceptInvite} element={<AcceptInvite />} />

      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          {ALL_NAV.filter((item) => item.placeholder === true).map((item) => (
            <Route
              key={item.key}
              path={item.path}
              element={<PlaceholderPage navKey={item.key} />}
            />
          ))}
          {/* M0-10. The nav item is install-admin only, but the route is not
              hidden: a non-admin who types the path gets the api's 403 drawn
              as "Not allowed", which is one answer in one place. */}
          <Route path={ROUTES.system} element={<SystemPage />} />
          <Route path={ROUTES.systemQueues} element={<SystemQueuesPage />} />
          <Route path={ROUTES.staff} element={<StaffScreen />} />
          {/* M1-04. `new` and `accounts/:id` are static-first, which React
              Router ranks above `:contactId`, so a contact can never be
              shadowed by a word. */}
          <Route path={ROUTES.contacts} element={<ContactsPage />} />
          <Route path={ROUTES.contactNew} element={<NewContactPage />} />
          <Route path={ROUTES.account} element={<AccountPage />} />
          <Route path={ROUTES.contact} element={<ContactPage />} />
          {/* M1-01. `/admin/ticketing` with no tab redirects to the first one,
              which the page itself does, so both paths are one component. */}
          <Route path={ROUTES.ticketing} element={<TicketingPage />} />
          <Route path={ROUTES.ticketingTab} element={<TicketingPage />} />
          <Route path={ROUTES.security} element={<SecurityScreen />} />
        </Route>

        {/* M1-15. Its own shell, without the page padding: the workspace is
            three columns inside one viewport-high frame (DESIGN §6.5). One
            route for the list and the ticket, because they are one screen. */}
        <Route element={<AppShell flush />}>
          <Route path={ROUTES.ticketWorkspace} element={<TicketsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to={DEFAULT_SIGNED_IN_ROUTE} replace />} />
    </Routes>
  );
}

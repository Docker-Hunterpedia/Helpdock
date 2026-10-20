import type { SignInResult } from '@helpdock/schemas';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { ROUTES } from '../app/route-paths.js';
import { useSetSession } from '../auth/session.tsx';

/**
 * Where a proved first factor leads, the same from the password form and the
 * sign-in link's confirm screen: into the app with the session, to the code
 * screen when the account has a second factor, or to enrolment when it must
 * have one and has none.
 */
export function useFinishSignIn(returnTo: string): (result: SignInResult) => void {
  const setSession = useSetSession();
  const navigate = useNavigate();

  return useCallback(
    (result: SignInResult) => {
      if (result.kind === 'session') {
        setSession(result.session);
        void navigate(returnTo, { replace: true });
        return;
      }

      if (result.kind === 'second-factor-enrolment-required') {
        void navigate(ROUTES.totpEnrolment, {
          replace: true,
          state: { challengeId: result.challengeId },
        });
        return;
      }

      void navigate(ROUTES.totp, {
        state: {
          challengeId: result.challengeId,
          email: result.email,
          factors: result.factors,
          returnTo,
        },
      });
    },
    [navigate, returnTo, setSession],
  );
}

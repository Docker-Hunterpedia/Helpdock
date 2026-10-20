import type { AuthErrorCode } from '@helpdock/schemas';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../app/i18n.js';
import type { AuthApi } from '../auth/api.js';
import { isAuthError } from '../auth/api.js';
import {
  assertPasskey,
  cancelPasskeyCeremony,
  isPasskeyCeremonyError,
  passkeyAutofillSupported,
  passkeysSupported,
} from '../auth/passkey-ceremony.js';
import { useSetSession } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';

/**
 * Signing in with a passkey on the sign-in page (M18-04, `Admin/Login-Passkey`):
 * the button, and the browser's autofill list on the email field. Both are
 * passwordless with user verification, so a success is a session and nothing
 * follows.
 */

export type PasskeyNotice = 'cancelled' | 'refused' | 'unreadable' | 'unsupported';

const NOTICE_KEYS = {
  cancelled: 'auth:signIn.passkeyCancelled',
  refused: 'auth:signIn.passkeyRefused',
  unreadable: 'auth:signIn.passkeyUnreadable',
  unsupported: 'auth:signIn.passkeyUnsupported',
} as const satisfies Record<PasskeyNotice, string>;

export interface PasskeySignIn {
  readonly waiting: boolean;
  readonly notice: PasskeyNotice | null;
  /** The api said the install's address moved; the button gives way to the warning. */
  readonly paused: boolean;
  readonly start: () => void;
  readonly cancel: () => void;
  readonly clearNotice: () => void;
}

/**
 * `available` is the api's word that this install offers passkey sign-in
 * (`methods().passkey`); when it is false nothing is started, not even the
 * autofill. `onRefusal` hears the failures that are not about the passkey
 * itself (a rate limit, SSO enforcement), which the page words like the
 * password form's.
 */
export function usePasskeySignIn({
  api,
  available,
  returnTo,
  onRefusal,
}: {
  readonly api: AuthApi;
  readonly available: boolean;
  readonly returnTo: string;
  readonly onRefusal: (code: AuthErrorCode, retryAfter: number | undefined) => void;
}): PasskeySignIn {
  const navigate = useNavigate();
  const setSession = useSetSession();
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<PasskeyNotice | null>(null);
  const [paused, setPaused] = useState(false);
  // Bumped when a ceremony the person started has ended, so the autofill one
  // that it cancelled starts again on the form that is back.
  const [round, setRound] = useState(0);
  const refusal = useRef(onRefusal);
  refusal.current = onRefusal;

  const signIn = useCallback(
    async (autofill: boolean): Promise<'signed-in' | 'cancelled' | 'failed'> => {
      try {
        const { ceremonyId, options } = await api.passkeySignInOptions();
        const response = await assertPasskey(options, { autofill });
        setSession(await api.signInWithPasskey({ ceremonyId, response }));
        void navigate(returnTo, { replace: true });
        return 'signed-in';
      } catch (error) {
        if (isPasskeyCeremonyError(error)) {
          // The autofill request is one nobody asked for: when the browser
          // cannot run it, the page says nothing and the button is still there.
          if (autofill || error.reason === 'cancelled') return 'cancelled';
          setNotice(error.reason === 'unsupported' ? 'unsupported' : 'unreadable');
        } else if (isAuthError(error) && error.code === 'invalid-credentials') {
          setNotice('refused');
        } else if (isAuthError(error) && error.code === 'passkeys-rp-changed') {
          setPaused(true);
        } else {
          refusal.current(
            isAuthError(error) ? error.code : 'unavailable',
            isAuthError(error) ? error.retryAfter : undefined,
          );
        }
        return 'failed';
      }
    },
    [api, navigate, returnTo, setSession],
  );

  // `round` is not read inside: bumping it restarts the autofill after a ceremony the person started ended.
  // biome-ignore lint/correctness/useExhaustiveDependencies: round is the restart signal.
  useEffect(() => {
    if (!available) return;
    let live = true;
    void (async () => {
      if (!(await passkeyAutofillSupported()) || !live) return;
      // A refusal is not retried: a browser that answered without being asked
      // would otherwise be asked again, forever.
      await signIn(true);
    })();
    return () => {
      live = false;
      cancelPasskeyCeremony();
    };
  }, [available, signIn, round]);

  const start = useCallback(() => {
    setNotice(null);
    setWaiting(true);
    void signIn(false).then((outcome) => {
      if (outcome === 'cancelled') setNotice('cancelled');
      if (outcome !== 'signed-in') {
        setWaiting(false);
        setRound((current) => current + 1);
      }
    });
  }, [signIn]);

  return {
    waiting,
    notice,
    paused,
    start,
    cancel: cancelPasskeyCeremony,
    clearNotice: () => {
      setNotice(null);
    },
  };
}

/** The notice above the form: neutral for a closed prompt, an error for a refusal. */
export function PasskeyNoticeBanner({ notice }: { readonly notice: PasskeyNotice }): ReactNode {
  const t = useT();

  return (
    <AlertBanner tone={notice === 'cancelled' ? 'info' : 'danger'}>
      {t(NOTICE_KEYS[notice])}
    </AlertBanner>
  );
}

/** The warning that replaces the button while the install's passkeys are paused. */
export function PasskeysPausedBanner(): ReactNode {
  const t = useT();

  return (
    <AlertBanner tone="warning">
      <strong>{t('auth:signIn.passkeyPausedTitle')}</strong>
      <br />
      {t('auth:signIn.passkeyPausedBody')}
    </AlertBanner>
  );
}

/** The button, disabled with its reason under it in a browser that cannot run a ceremony. */
export function PasskeyButton({
  onClick,
  disabled,
}: {
  readonly onClick: () => void;
  readonly disabled: boolean;
}): ReactNode {
  const t = useT();
  const supported = passkeysSupported();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Button
        type="button"
        variant="outlined"
        color="secondary"
        fullWidth
        disabled={disabled || !supported}
        aria-describedby={supported ? undefined : 'sign-in-passkey-unsupported'}
        startIcon={<KeyRound size={16} aria-hidden="true" />}
        onClick={onClick}
      >
        {t('auth:signIn.passkey')}
      </Button>
      {supported ? null : (
        <Typography
          id="sign-in-passkey-unsupported"
          variant="caption"
          sx={{ color: 'text.secondary' }}
        >
          {t('auth:signIn.passkeyUnsupported')}
        </Typography>
      )}
    </Box>
  );
}

/** What replaces the form while the browser's prompt is open. */
export function PasskeyWaiting({ onCancel }: { readonly onCancel: () => void }): ReactNode {
  const t = useT();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Box
        role="status"
        sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'text.secondary' }}
      >
        <CircularProgress size={16} aria-hidden="true" />
        <Typography variant="body2" sx={{ color: 'inherit' }}>
          {t('auth:signIn.passkeyWaiting')}
        </Typography>
      </Box>
      <Button type="button" variant="outlined" color="secondary" fullWidth onClick={onCancel}>
        {t('auth:signIn.passkeyCancel')}
      </Button>
    </Box>
  );
}

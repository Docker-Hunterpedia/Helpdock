/** Every path in the admin app, in one place so links cannot drift. */
export const ROUTES = {
  signIn: '/sign-in',
  totp: '/sign-in/totp',
  magicLinkSent: '/sign-in/link-sent',
  /** Where the api redirects after a magic link, carrying a one-time code. */
  authComplete: '/sign-in/complete',
  passwordResetSent: '/sign-in/reset-sent',
  passwordReset: '/sign-in/reset',
  /** The two-step second-factor enrolment of `Admin/Enrol2FA` (M0-06). */
  totpEnrolment: '/sign-in/enrol',
  /** Public: the only screen somebody without an account ever reaches. */
  acceptInvite: '/invite/:token',
  oauthCallback: '/oauth/callback',
  tickets: '/tickets',
  contacts: '/contacts',
  helpCenter: '/help-center',
  reports: '/reports',
  settings: '/admin/settings',
  staff: '/admin/staff',
  system: '/admin/system',
  /** Where "Open queue dashboard" goes until Bull Board is embedded (M8-05, ADR 0004). */
  systemQueues: '/admin/system/queues',
  /** A person's own account: password, second factor, signed-in browsers. */
  security: '/me/security',
} as const;

/** The invite link the api emails, with the token in it. */
export const inviteRoute = (token: string): string => `/invite/${encodeURIComponent(token)}`;

/** Where a sign-in lands when nothing asked for a particular screen. */
export const DEFAULT_SIGNED_IN_ROUTE = ROUTES.tickets;

export const RETURN_TO_PARAM = 'returnTo';

/**
 * A `returnTo` is only followed when it is a path inside this app. Anything
 * else — a scheme, a host, a protocol-relative `//evil.example` — falls back to
 * the default screen, so the parameter cannot become an open redirect.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value?.startsWith('/') || value.startsWith('//')) {
    return DEFAULT_SIGNED_IN_ROUTE;
  }

  return value;
}

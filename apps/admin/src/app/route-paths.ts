/** Every path in the admin app, in one place so links cannot drift. */
export const ROUTES = {
  /** The first-run wizard. Mounted only while the install is `fresh` (M0-08). */
  setup: '/setup',
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
  /** The create form, on a route of its own so it can be linked to (M1-04). */
  contactNew: '/contacts/new',
  contact: '/contacts/:contactId',
  /** Nested under contacts because an account is a group of them, not a peer. */
  account: '/contacts/accounts/:accountId',
  helpCenter: '/help-center',
  reports: '/reports',
  settings: '/admin/settings',
  /** How this brand's tickets are shaped and routed (M1-01). */
  ticketing: '/admin/ticketing',
  /** One tab of it. `/admin/ticketing` alone redirects to the first. */
  ticketingTab: '/admin/ticketing/:tab',
  staff: '/admin/staff',
  system: '/admin/system',
  /** Where "Open queue dashboard" goes until Bull Board is embedded (M8-05, ADR 0004). */
  systemQueues: '/admin/system/queues',
  /** A person's own account: password, second factor, signed-in browsers. */
  security: '/me/security',
} as const;

export const contactRoute = (contactId: string): string =>
  `/contacts/${encodeURIComponent(contactId)}`;

export const accountRoute = (accountId: string): string =>
  `/contacts/accounts/${encodeURIComponent(accountId)}`;

/** The invite link the api emails, with the token in it. */
export const inviteRoute = (token: string): string => `/invite/${encodeURIComponent(token)}`;

/** One tab of the Ticketing settings, by its url segment. */
export const ticketingRoute = (tab: string): string => `${ROUTES.ticketing}/${tab}`;

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

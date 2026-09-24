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
  /** One ticket, beside the list it came from (M1-15). */
  ticket: '/tickets/:ticketId',
  /**
   * What the router actually registers, once, for both of the above.
   *
   * One route, not two, and a splat rather than an optional parameter: two
   * `<Route>`s rendering the same component unmount and remount it every time
   * a ticket is opened or closed, and the workspace keeps things a remount
   * throws away — the composer's draft, which sends are still in flight, and a
   * window-level key listener that for a frame would be the old mount's.
   *
   * The id is read from the path by {@link ticketIdFromPath} instead.
   */
  ticketWorkspace: '/tickets/*',
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
  /**
   * The public rating page (M1-12). Not a route of the admin router: `main.tsx`
   * mounts the page on its own for this prefix, without the staff providers.
   */
  csat: '/csat/',
} as const;

export const ticketRoute = (ticketId: string): string => `/tickets/${encodeURIComponent(ticketId)}`;

/**
 * The ticket the workspace has open, from the path it is being read at.
 *
 * `/tickets` is the list with nothing open; `/tickets/<id>` is that ticket.
 * Anything deeper is still that ticket — a stray segment is not worth a dead
 * end on a screen whose whole state is in the URL.
 */
export function ticketIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(ROUTES.tickets)) {
    return null;
  }

  const [id = ''] = pathname.slice(ROUTES.tickets.length).replace(/^\//, '').split('/');

  return id === '' ? null : decodeURIComponent(id);
}

export const contactRoute = (contactId: string): string =>
  `/contacts/${encodeURIComponent(contactId)}`;

export const accountRoute = (accountId: string): string =>
  `/contacts/accounts/${encodeURIComponent(accountId)}`;

/** The invite link the api emails, with the token in it. */
export const inviteRoute = (token: string): string => `/invite/${encodeURIComponent(token)}`;

/** The rating link's token, when the path is the rating page; otherwise null. */
export function csatTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(ROUTES.csat)) {
    return null;
  }

  const [token = ''] = pathname.slice(ROUTES.csat.length).split('/');

  return token === '' ? null : decodeURIComponent(token);
}

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

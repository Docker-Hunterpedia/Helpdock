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
  /** One tab of it: Articles, Settings, Insights. `/help-center` alone opens Articles. */
  helpCenterTab: '/help-center/:tab',
  /** The article editor (M5-02). Deeper than a tab, so the two never compete. */
  helpCenterArticle: '/help-center/articles/:articleId',
  /**
   * M5-03: asks for a staff pass and leaves for the help center on the
   * brand's host. Static, so it wins over `/help-center/:tab`.
   */
  helpCenterOpen: '/help-center/open',
  reports: '/reports',
  settings: '/admin/settings',
  /** How this brand's tickets are shaped and routed (M1-01). */
  ticketing: '/admin/ticketing',
  /** One tab of it. `/admin/ticketing` alone redirects to the first. */
  ticketingTab: '/admin/ticketing/:tab',
  /** Workflow rules, time-based rules and macros (M3-03 to M3-06). */
  automation: '/admin/automation',
  /** One tab of it. `/admin/automation` alone redirects to the first the reader has. */
  automationTab: '/admin/automation/:tab',
  /** The rule builder (M3-05): a saved rule, or `new` with `?kind=`. */
  automationRule: '/admin/automation/rules/:ruleId',
  /** The brand's own settings: General, Domains (M5-07) and Danger zone (M1-14). */
  brand: '/admin/brand',
  /** One tab of it. `/admin/brand` alone redirects to the first built one. */
  brandTab: '/admin/brand/:tab',
  /** How customers reach the brand (M2-08): Mailboxes, then M2-05's Outgoing email. */
  channels: '/admin/channels',
  /** One tab of it. `/admin/channels` alone redirects to Mailboxes. */
  channelsTab: '/admin/channels/:tab',
  /** "Add mailbox" (`Admin/Email-Mailbox` in add mode). */
  mailboxNew: '/admin/channels/mailboxes/new',
  /** One mailbox's form. */
  mailbox: '/admin/channels/mailboxes/:mailboxId',
  /** API keys and webhooks (M8-01, M8-03). `/admin/developers` alone opens API keys. */
  developers: '/admin/developers',
  developersTab: '/admin/developers/:tab',
  staff: '/admin/staff',
  system: '/admin/system',
  /** The install-wide audit log (M3-08), reached from System. */
  systemAuditLog: '/admin/system/audit-log',
  /** Where "Open queue dashboard" goes until Bull Board is embedded (M8-05, ADR 0004). */
  systemQueues: '/admin/system/queues',
  /**
   * Your account (M3-07): one page, three tabs. `/me` alone redirects to the
   * first; Security keeps the path it always had.
   */
  me: '/me',
  meTab: '/me/:tab',
  /** A person's own account: password, second factor, signed-in browsers. */
  security: '/me/security',
  /** What they are told about, and where (M3-07). */
  meNotifications: '/me/notifications',
  /** Their email signature (M2-05, artboard `AdminSignature`). */
  signature: '/me/signature',
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

/**
 * The rating page over a sample (M1-15 part 2), in the language asked for.
 * `preview` is `CSAT_PREVIEW_TOKEN`, spelled out here so this file stays free
 * of imports; `route-paths.test.ts` holds the two together.
 */
export const csatPreviewRoute = (locale: string): string =>
  `${ROUTES.csat}preview?lang=${encodeURIComponent(locale)}`;

/** One tab of the Ticketing settings, by its url segment. */
export const ticketingRoute = (tab: string): string => `${ROUTES.ticketing}/${tab}`;

/** One tab of Channels, by its url segment. */
export const channelsRoute = (tab: string): string => `${ROUTES.channels}/${tab}`;

/** One mailbox's form. */
export const mailboxRoute = (mailboxId: string): string =>
  `${ROUTES.channels}/mailboxes/${encodeURIComponent(mailboxId)}`;

/** One tab of `Admin/Automation`, by its url segment. */
export const automationRoute = (tab: string): string => `${ROUTES.automation}/${tab}`;

/** The builder for one rule, or for a new one of a kind. */
export const ruleRoute = (ruleId: string): string =>
  `${ROUTES.automation}/rules/${encodeURIComponent(ruleId)}`;

/** One tab of the Help center page, by its url segment. */
export const helpCenterRoute = (tab: string): string => `${ROUTES.helpCenter}/${tab}`;

/** One article in the editor. */
export const articleRoute = (articleId: string): string =>
  `${ROUTES.helpCenter}/articles/${encodeURIComponent(articleId)}`;

/** One tab of the Developers page, by its url segment. */
export const developersRoute = (tab: string): string => `${ROUTES.developers}/${tab}`;

/** One tab of the Brand page, by its url segment. */
export const brandRoute = (tab: string): string => `${ROUTES.brand}/${tab}`;

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

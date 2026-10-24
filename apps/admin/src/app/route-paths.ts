import { ssoReturnToSchema } from '@helpdock/schemas';
import { matchPath } from 'react-router';
/** Every path in the admin app, in one place so links cannot drift. */
export const ROUTES = {
  /** The first-run wizard. Mounted only while the install is `fresh` (M0-08). */
  setup: '/setup',
  signIn: '/sign-in',
  totp: '/sign-in/totp',
  magicLinkSent: '/sign-in/link-sent',
  /**
   * Where a sign-in link opens, with the token in the fragment: the confirm
   * screen that spends it only on a click (M9-01 F6).
   */
  magicLink: '/sign-in/magic',
  /** Where the api redirects after an OAuth or SSO sign-in, carrying a one-time code. */
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
  /**
   * The Settings area (M14-21): one sidebar entry opening a shell with a grouped
   * secondary navigation. `/settings` alone opens the first page the reader has.
   * The groups are Your account, Brand, Inbox, Channels, AI, Developers and
   * Install; `LEGACY_REDIRECTS` below maps every URL the admin had before.
   */
  settings: '/settings',

  /** Your account (M3-07, M14-12): one page per tab. `/settings/account` alone opens Profile. */
  myAccount: '/settings/account',
  myAccountTab: '/settings/account/:tab',
  /** How a person appears to customers: public name, title, phone, photo, time zone (M14-12). */
  meProfile: '/settings/account/profile',
  /** A person's own account: password, second factor, signed-in browsers. */
  security: '/settings/account/security',
  /** What they are told about, and where (M3-07). */
  meNotifications: '/settings/account/notifications',
  /** Their email signature (M2-05, artboard `AdminSignature`). */
  signature: '/settings/account/signature',

  /** The brand's own settings: General, Domains (M5-07) and Danger zone (M1-14). */
  brand: '/settings/brand',
  /** One page of it. `/settings/brand` alone redirects to General. */
  brandTab: '/settings/brand/:tab',

  /**
   * Inbox: how this brand's tickets are shaped and routed (M1-01) and
   * automated (M3-03 to M3-06). `/settings/inbox` alone opens the first page
   * the reader has.
   */
  inbox: '/settings/inbox',
  /** One page of it: a ticketing setting, or Rules, Time-based, Routing or Macros. */
  inboxTab: '/settings/inbox/:tab',
  /** The rule builder (M3-05): a saved rule, or `new` with `?kind=`. */
  automationRule: '/settings/inbox/rules/:ruleId',
  /**
   * The two halves of the Inbox group by the names they had as areas. They are
   * the same prefix, kept so a link to "the ticketing settings" or "the
   * automation pages" reads as that: `${ROUTES.ticketing}/slas`.
   */
  ticketing: '/settings/inbox',
  automation: '/settings/inbox',

  /** How customers reach the brand (M2-08): Mailboxes, then M2-05's Outgoing email. */
  channels: '/settings/channels',
  /** One page of it. `/settings/channels` alone opens the first the reader has. */
  channelsTab: '/settings/channels/:tab',
  /** "Add mailbox" (`Admin/Email-Mailbox` in add mode). */
  mailboxNew: '/settings/channels/mailboxes/new',
  /** One mailbox's form. */
  mailbox: '/settings/channels/mailboxes/:mailboxId',
  /** One Telegram bot's page (M6-05, `Admin/Channels-Telegram` panel 2). */
  telegramBot: '/settings/channels/telegram/:botId',
  /** One Meta account's page (M10-07, `Admin/Channels-Meta-Account`). */
  metaAccount: '/settings/channels/meta/:accountId',

  /** Providers, Knowledge and Assistant (M7-10). `/settings/ai` alone opens the first the reader has. */
  ai: '/settings/ai',
  aiTab: '/settings/ai/:tab',

  /** API keys and webhooks (M8-01, M8-03). `/settings/developers` alone opens API keys. */
  developers: '/settings/developers',
  developersTab: '/settings/developers/:tab',

  /** Install-wide sign-in settings (M0-02). */
  authentication: '/settings/install/authentication',
  /** Single sign-on connections (M11). */
  sso: '/settings/install/sso',
  ssoConnection: '/settings/install/sso/:id',
  staff: '/settings/install/staff',
  system: '/settings/install/system',
  /** The install-wide audit log (M3-08), reached from System. */
  systemAuditLog: '/settings/install/system/audit-log',
  /** Where "Open queue dashboard" goes until Bull Board is embedded (M8-05, ADR 0004). */
  systemQueues: '/settings/install/system/queues',
  /** Importing from another help desk (M11). */
  imports: '/settings/install/imports',
  importRun: '/settings/install/imports/:runId',

  /**
   * The public rating page (M1-12). Not a route of the admin router: `main.tsx`
   * mounts the page on its own for this prefix, without the staff providers.
   */
  csat: '/csat/',
  /**
   * The unsubscribe page a notification email links to (M14-11). Like the
   * rating page, `main.tsx` mounts it on its own, without the staff providers.
   */
  unsubscribe: '/unsubscribe/',
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

/** The unsubscribe link's token, when the path is the unsubscribe page; otherwise null. */
export function unsubscribeTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(ROUTES.unsubscribe)) {
    return null;
  }

  const [token = ''] = pathname.slice(ROUTES.unsubscribe.length).split('/');

  return token === '' ? null : decodeURIComponent(token);
}

/**
 * The rating page over a sample (M1-15 part 2), in the language asked for.
 * `preview` is `CSAT_PREVIEW_TOKEN`, spelled out here so this file stays free
 * of imports; `route-paths.test.ts` holds the two together.
 */
export const csatPreviewRoute = (locale: string): string =>
  `${ROUTES.csat}preview?lang=${encodeURIComponent(locale)}`;

/** One page of the Inbox group that is a ticketing setting, by its url segment. */
export const ticketingRoute = (tab: string): string => `${ROUTES.inbox}/${tab}`;

/** One tab of Channels, by its url segment. */
export const channelsRoute = (tab: string): string => `${ROUTES.channels}/${tab}`;

/** One mailbox's form. */
export const mailboxRoute = (mailboxId: string): string =>
  `${ROUTES.channels}/mailboxes/${encodeURIComponent(mailboxId)}`;

/** One Telegram bot's page. */
export const telegramBotRoute = (botId: string): string =>
  `${ROUTES.channels}/telegram/${encodeURIComponent(botId)}`;

/** One Meta account's page. */
export const metaAccountRoute = (accountId: string): string =>
  `${ROUTES.channels}/meta/${encodeURIComponent(accountId)}`;

/** One page of the Inbox group that is automation (Rules, Time-based, Routing, Macros). */
export const automationRoute = (tab: string): string => `${ROUTES.inbox}/${tab}`;

/** The builder for one rule, or for a new one of a kind. */
export const ruleRoute = (ruleId: string): string =>
  `${ROUTES.inbox}/rules/${encodeURIComponent(ruleId)}`;

/** One tab of the Help center page, by its url segment. */
export const helpCenterRoute = (tab: string): string => `${ROUTES.helpCenter}/${tab}`;

/** One article in the editor. */
export const articleRoute = (articleId: string): string =>
  `${ROUTES.helpCenter}/articles/${encodeURIComponent(articleId)}`;

/** One tab of `Admin/AI`, by its url segment. */
export const aiRoute = (tab: string): string => `${ROUTES.ai}/${tab}`;
/** One tab of the Developers page, by its url segment. */
export const developersRoute = (tab: string): string => `${ROUTES.developers}/${tab}`;

/** One tab of the Brand page, by its url segment. */
export const brandRoute = (tab: string): string => `${ROUTES.brand}/${tab}`;
export const importRunRoute = (runId: string): string =>
  `${ROUTES.imports}/${encodeURIComponent(runId)}`;

/** Where a sign-in lands when nothing asked for a particular screen. */
export const DEFAULT_SIGNED_IN_ROUTE = ROUTES.tickets;

export const RETURN_TO_PARAM = 'returnTo';

/**
 * The token of a sign-in link, from the fragment the api puts it in
 * (`/sign-in/magic#token=…`). A fragment never reaches a server, so the token
 * is in no request log and no `Referer`. Empty when there is none.
 */
export const magicLinkTokenFromHash = (hash: string): string =>
  new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token') ?? '';

/**
 * A `returnTo` is only followed when it is a path inside this app. Anything
 * else — a scheme, a host, a protocol-relative `//evil.example` — falls back to
 * the default screen, so the parameter cannot become an open redirect.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return DEFAULT_SIGNED_IN_ROUTE;
  const parsed = ssoReturnToSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SIGNED_IN_ROUTE;
}

export const ssoConnectionRoute = (id: string): string => `${ROUTES.sso}/${encodeURIComponent(id)}`;

/**
 * Where every admin URL from before the Settings area (M14-21) lives now.
 *
 * Bookmarks, guides, emails the api already sent and the setup checklist all
 * hold the old paths, so each one redirects instead of ending on the default
 * screen. Patterns are matched in order against the pathname alone; `:name` and
 * a trailing `*` carry over to `to`, and the query string and fragment are kept
 * by `legacyRedirect`. More specific patterns come first.
 *
 * The bare area paths that used to redirect to "the first tab the reader has"
 * point at the group page that still does.
 */
export const LEGACY_REDIRECTS: readonly { readonly from: string; readonly to: string }[] = [
  { from: '/me', to: ROUTES.meProfile },
  { from: '/me/:tab', to: `${ROUTES.myAccount}/:tab` },

  { from: '/admin/settings', to: ROUTES.authentication },
  { from: '/admin/settings/sso/:id', to: `${ROUTES.sso}/:id` },

  { from: '/admin/ticketing', to: ticketingRoute('departments') },
  { from: '/admin/ticketing/:tab', to: `${ROUTES.inbox}/:tab` },

  { from: '/admin/automation', to: automationRoute('rules') },
  { from: '/admin/automation/rules/:ruleId', to: `${ROUTES.inbox}/rules/:ruleId` },
  { from: '/admin/automation/:tab', to: `${ROUTES.inbox}/:tab` },

  { from: '/admin/brand', to: ROUTES.brand },
  { from: '/admin/brand/import', to: ROUTES.imports },
  { from: '/admin/brand/import/:runId', to: `${ROUTES.imports}/:runId` },
  { from: '/admin/brand/:tab', to: `${ROUTES.brand}/:tab` },

  { from: '/admin/channels/*', to: `${ROUTES.channels}/*` },
  { from: '/admin/ai/*', to: `${ROUTES.ai}/*` },
  { from: '/admin/developers/*', to: `${ROUTES.developers}/*` },

  { from: '/admin/staff', to: ROUTES.staff },
  { from: '/admin/system/*', to: `${ROUTES.system}/*` },
];

/** The Authentication tab's old `?tab=` values that are a page of their own now. */
const SETTINGS_TAB_PAGES: Readonly<Record<string, string>> = { sso: ROUTES.sso };

/**
 * The new address of a pre-M14-21 admin URL, or null when the path was never
 * one. The query string and fragment travel with it, so a deep link keeps its
 * filters; the one query parameter that named a tab (`/admin/settings?tab=sso`)
 * becomes the page it opened.
 */
export function legacyRedirect(pathname: string, search = '', hash = ''): string | null {
  for (const { from, to } of LEGACY_REDIRECTS) {
    const match = matchPath({ path: from, end: true }, pathname);
    if (match === null) {
      continue;
    }

    const splat = (match.params['*'] ?? '').split('/').map(encodeURIComponent).join('/');
    let target = to.replace(/\/\*$/, splat === '' ? '' : `/${splat}`);
    for (const [name, value] of Object.entries(match.params)) {
      if (name !== '*' && value !== undefined) {
        target = target.replace(`:${name}`, encodeURIComponent(value));
      }
    }

    let query = search;
    if (pathname === '/admin/settings') {
      const params = new URLSearchParams(search);
      const page = SETTINGS_TAB_PAGES[params.get('tab') ?? ''];
      if (page !== undefined) {
        target = page;
      }
      params.delete('tab');
      const rest = params.toString();
      query = rest === '' ? '' : `?${rest}`;
    }

    return `${target}${query}${hash}`;
  }

  return null;
}

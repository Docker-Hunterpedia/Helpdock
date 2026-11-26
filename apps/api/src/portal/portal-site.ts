import type { PowChallenge } from '@helpdock/channels';
import { createI18n } from '@helpdock/i18n';
import {
  captchaChallengeSchema,
  type HcLocale,
  normaliseEmail,
  type PortalConfirmForm,
  type PortalSessionForm,
  type PortalSignInForm,
  portalConfirmFormSchema,
  portalSessionFormSchema,
  portalSignInFormSchema,
} from '@helpdock/schemas';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import type { SiteLinks } from '../help-center/site/paths.js';
import { translator } from '../help-center/site/render/text.js';
import type { SiteConfig } from '../help-center/site/site-config.js';
import type { PageContext, Rendered } from '../help-center/site/views.js';
import { renderPortalPage } from '../help-center/site/views.js';
import { POW_SCRIPT } from '../web-form/page/pow-script.js';
import {
  confirmMain,
  deadLinkMain,
  FOCUS_SCRIPT,
  PORTAL_CSS,
  type PowStrip,
  type SignInError,
  sentMain,
  signInMain,
  staleMain,
} from './portal-pages.js';
import type { LiveSession, TokenState } from './portal-store.js';
import {
  csrfToken,
  csrfValid,
  hashToken,
  isTokenShaped,
  maskCsrf,
  NONCE_TTL_SECONDS,
  newToken,
  nonceCookieName,
  SESSION_TTL_MS,
  safePortalNext,
  sessionCookieName,
} from './session-rules.js';
import { parseListQuery, type TicketListQuery } from './ticket-list-rules.js';
import { TICKET_CSS, ticketListMain, ticketMain } from './ticket-pages.js';
import { parseTicketReference, type TicketReference } from './ticket-reference.js';
import type { AttachmentLookup, PortalTicketList, TicketLookup } from './ticket-views.js';

/**
 * The customer portal's sign-in pages and routes (M21-02, ADR 0059, artboard
 * `HelpCenter/Portal-SignIn`), apart from Nest and from the database: it talks
 * to a {@link PortalStore}, so the same code answers the api, the integration
 * suites over Postgres and the Playwright server over memory.
 *
 * | Route | |
 * |---|---|
 * | `GET /sign-in` | the form |
 * | `POST /sign-in` | asks for a link: always the same answer for any well-formed address |
 * | `GET /sign-in/challenge` | a new built-in CAPTCHA challenge |
 * | `GET /sign-in/confirm?token=` | the Continue page: reads the link, spends nothing |
 * | `POST /sign-in/confirm` | spends the link, sets the session cookie |
 * | `POST /sign-out`, `POST /sign-out-everywhere` | end the session, or all of the contact's |
 * | `GET /tickets` | the customer's ticket list (M21-03) |
 * | `GET /tickets/<ref>` | one ticket, read-only; a ticket that is not the customer's is the help center's 404 |
 * | `GET /tickets/<ref>/attachments/<id>` | a redirect to the file's short-lived address, after the parent ticket is authorised |
 *
 * Every answer is `private, no-store` and never reaches the page cache.
 */

export const PORTAL_PATHS = [
  '/sign-in',
  '/sign-in/challenge',
  '/sign-in/confirm',
  '/sign-out',
  '/sign-out-everywhere',
  '/tickets',
] as const;

/** 5 link requests per address per hour (ADR 0059 §3). */
export const PORTAL_LINK_EMAIL_RULE: RateLimitRule = {
  bucket: 'portal-link-email',
  limit: 5,
  windowSeconds: 60 * 60,
};
/** 20 per IP per hour. */
export const PORTAL_LINK_IP_RULE: RateLimitRule = {
  bucket: 'portal-link-ip',
  limit: 20,
  windowSeconds: 60 * 60,
};
/** The Continue page and its button, per IP: a 256-bit link is not guessed; this bounds probing. */
export const PORTAL_CONFIRM_IP_RULE: RateLimitRule = {
  bucket: 'portal-confirm-ip',
  limit: 30,
  windowSeconds: 15 * 60,
};
export const PORTAL_CHALLENGE_IP_RULE: RateLimitRule = {
  bucket: 'portal-challenge-ip',
  limit: 30,
  windowSeconds: 15 * 60,
};

export type ConfirmOutcome =
  | { readonly kind: 'signed-in'; readonly contactId: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'used' };

/** What the pages read and write; `DbPortalStore` is the real one. */
export interface PortalStore {
  /**
   * Sends a link when this brand may send one to this address: a contact has it
   * as an email identity, or the brand lets new customers in. Never throws for
   * an address that has no contact.
   */
  issueLink(input: {
    readonly brandId: string;
    readonly email: string;
    readonly locale: HcLocale;
    readonly tokenHash: string;
    readonly confirmUrl: (token: string) => string;
    readonly token: string;
    readonly now: Date;
  }): Promise<'issued' | 'skipped'>;
  readLink(brandId: string, token: string, now: Date): Promise<TokenState>;
  confirm(input: {
    readonly brandId: string;
    readonly token: string;
    readonly sessionTokenHash: string;
    readonly host: string;
    readonly userAgentFamily: string | null;
    /** The language of the page the link was pressed on; a contact made by this sign-in keeps it. */
    readonly locale: HcLocale;
    readonly now: Date;
  }): Promise<ConfirmOutcome>;
  /** The session the cookie names, if it is still good for this brand and host. */
  session(input: {
    readonly brandId: string;
    readonly token: string;
    readonly host: string;
    readonly now: Date;
  }): Promise<LiveSession | null>;
  /** The customer's tickets, newest change first, as the customer policy lets them be read (M21-03). */
  tickets(session: LiveSession, query: TicketListQuery): Promise<PortalTicketList>;
  ticket(session: LiveSession, reference: TicketReference): Promise<TicketLookup>;
  /** A short-lived address for one file of a visible ticket, or null for every reason there is not one. */
  attachment(
    session: LiveSession,
    reference: TicketReference,
    attachmentId: string,
  ): Promise<AttachmentLookup>;
  endSession(brandId: string, sessionId: string): Promise<void>;
  endAllSessions(brandId: string, contactId: string): Promise<void>;
}

/** The built-in check, when the brand's web form has it on (ADR 0052). */
export interface PortalCaptcha {
  /** Whether this brand's web form has the built-in check on, so the sign-in form asks for it too. */
  required(brandId: string): Promise<boolean>;
  /** A fresh challenge when the check is required for this brand, else null. */
  challenge(brandId: string): Promise<PowChallenge | null>;
  /** Whether the posted solution is good, and spends it. */
  spend(brandId: string, token: string): Promise<boolean>;
}

export interface PortalRequest {
  readonly method: 'GET' | 'POST';
  readonly host: string | undefined;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: {
    readonly acceptLanguage?: string | undefined;
    readonly userAgent?: string | undefined;
  };
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly ip: string;
  readonly body?: unknown;
}

export interface PortalSecurityLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PortalDeps {
  readonly store: PortalStore;
  readonly captcha: PortalCaptcha;
  readonly limiter: Pick<RateLimiter, 'consume'>;
  readonly csrfKey: Buffer;
  readonly log: PortalSecurityLog;
  readonly now?: () => Date;
}

/** What `HelpCenterSite` hands the portal for one request. */
export interface PortalHost {
  readonly request: PortalRequest;
  readonly brandId: string;
  /** The path below the base, no query, no trailing slash. */
  readonly path: string;
  readonly links: SiteLinks;
  readonly config: SiteConfig;
  /** Whether this is the brand's own host (cookie names then carry no brand id). */
  readonly byHost: boolean;
  readonly secure: boolean;
  /** The page's language: `?lang=`, else Accept-Language, else the brand's. */
  locale(requested: string | undefined): HcLocale;
  /** A minimal page context: no article tree, a signed-in header when `session` is given. */
  context(locale: HcLocale, session?: LiveSession, csrf?: string): PageContext;
  respond(input: {
    readonly status: number;
    readonly rendered: Rendered;
    readonly pow: boolean;
    readonly cookies?: readonly PortalCookie[];
  }): PortalResponse;
  /** The help center's own not-found page, `private, no-store`, with the signed-in menu when there is a session. */
  notFound(locale: HcLocale, session?: LiveSession, csrf?: string): PortalResponse;
  redirect(location: string, cookies?: readonly PortalCookie[]): PortalResponse;
  json(status: number, body: unknown): PortalResponse;
  plain(status: number, body: string): PortalResponse;
}

export interface PortalCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly maxAge: number;
  readonly secure: boolean;
}

export interface PortalResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly cookies: readonly PortalCookie[];
  /** Work that runs after the response is sent, so its timing never shows in it. */
  readonly after?: () => Promise<void>;
}

/** A short family name for the session row, never the raw user agent. */
export const userAgentFamily = (userAgent: string | undefined): string | null => {
  if (userAgent === undefined) {
    return null;
  }
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null;
  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  if (browser === null && system === null) {
    return null;
  }
  return [browser ?? 'Browser', system === null ? '' : `on ${system}`].filter(Boolean).join(' ');
};

/** What a signed-in page works from: the live session and the cookie value it came from. */
interface SignedIn {
  readonly session: LiveSession;
  readonly token: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The non-dismissible note over the list (artboard `HelpCenter/Portal-Tickets`):
 * a member of an account that shows all tickets is told, on Mine, that coworkers
 * see what they open; a manager is told, on Company, why they see everything.
 */
const noticeOf = (
  scope: NonNullable<LiveSession['scope']>,
  query: TicketListQuery,
  company: string | null,
): 'all' | 'manager' | null => {
  if (company === null) {
    return null;
  }
  if (query.scope === 'mine') {
    return scope.visibility === 'all' ? 'all' : null;
  }
  return scope.role === 'manager' ? 'manager' : null;
};

const ok = <T>(parsed: { success: true; data: T } | { success: false }): T | null =>
  parsed.success ? parsed.data : null;

export class PortalSite {
  readonly #deps: PortalDeps;

  constructor(deps: PortalDeps) {
    this.#deps = deps;
  }

  /** The portal's answer, or null when the path is not one of its own. */
  async handle(host: PortalHost): Promise<PortalResponse | null> {
    const { request, path } = host;
    if (request.method === 'GET' && path.startsWith('/tickets/')) {
      return this.#ticketRoute(host);
    }
    if (!(PORTAL_PATHS as readonly string[]).includes(path)) {
      return null;
    }
    if (request.method === 'GET') {
      switch (path) {
        case '/sign-in':
          return this.#showSignIn(host);
        case '/sign-in/challenge':
          return this.#challenge(host);
        case '/sign-in/confirm':
          return this.#showConfirm(host);
        case '/tickets':
          return this.#tickets(host);
        default:
          return null;
      }
    }
    switch (path) {
      case '/sign-in':
        return this.#requestLink(host);
      case '/sign-in/confirm':
        return this.#spendLink(host);
      case '/sign-out':
        return this.#signOut(host, false);
      case '/sign-out-everywhere':
        return this.#signOut(host, true);
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- cookies

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #names(host: PortalHost) {
    const brandId = host.byHost ? null : host.brandId;
    return {
      session: sessionCookieName({ secure: host.secure, brandId }),
      nonce: nonceCookieName({ secure: host.secure, brandId }),
    };
  }

  #cookie(host: PortalHost, name: string, value: string, maxAgeSeconds: number): PortalCookie {
    // `__Host-` forbids any other path, so the cookie is host-wide and the name carries the brand.
    return { name, value, path: '/', maxAge: maxAgeSeconds, secure: host.secure };
  }

  /** The pre-session nonce: the one the browser has, or a new one to set. */
  #nonce(host: PortalHost): { value: string; cookies: PortalCookie[] } {
    const name = this.#names(host).nonce;
    const existing = host.request.cookies[name];
    if (isTokenShaped(existing)) {
      return { value: existing, cookies: [] };
    }
    const value = newToken();
    return { value, cookies: [this.#cookie(host, name, value, NONCE_TTL_SECONDS)] };
  }

  async #liveSession(host: PortalHost): Promise<{ session: LiveSession; token: string } | null> {
    const token = host.request.cookies[this.#names(host).session];
    if (!isTokenShaped(token) || host.request.host === undefined) {
      return null;
    }
    const session = await this.#deps.store.session({
      brandId: host.brandId,
      token,
      host: host.request.host,
      now: this.#now(),
    });
    return session === null ? null : { session, token };
  }

  // ---------------------------------------------------------------- pages

  #page(
    host: PortalHost,
    locale: HcLocale,
    page: {
      titleKey: string;
      main: string;
      status?: number;
      query?: Record<string, string | undefined>;
      pow?: boolean;
      cookies?: readonly PortalCookie[];
      css?: string;
      /** The signed-in customer: the header draws their menu, its forms carrying a CSRF token masked for this response. */
      live?: SignedIn;
    },
  ): PortalResponse {
    const context = host.context(
      locale,
      page.live?.session,
      page.live === undefined ? undefined : this.#maskedCsrf(page.live),
    );
    const other: HcLocale = locale === 'en' ? 'ar' : 'en';
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(page.query ?? {})) {
      if (value !== undefined) {
        params.set(name, value);
      }
    }
    params.set('lang', other);
    const rendered = renderPortalPage(context, {
      titleKey: page.titleKey,
      otherLocaleHref: `${host.links.base}${host.path}?${params.toString()}`,
      main: page.main,
      css: page.css ?? PORTAL_CSS,
      scripts: page.pow === true ? [FOCUS_SCRIPT, POW_SCRIPT] : [FOCUS_SCRIPT],
      ...(page.status === undefined ? {} : { status: page.status }),
    });
    return host.respond({
      status: page.status ?? 200,
      rendered,
      pow: page.pow ?? false,
      ...(page.cookies === undefined ? {} : { cookies: page.cookies }),
    });
  }

  async #powStrip(host: PortalHost, locale: HcLocale): Promise<PowStrip | null> {
    const challenge = await this.#deps.captcha.challenge(host.brandId);
    if (challenge === null) {
      return null;
    }
    const w = createI18n({ lng: locale }).getFixedT(locale, 'webform');
    return {
      challenge,
      refreshPath: host.links.portalChallenge(),
      words: {
        label: w('captcha.label'),
        needsScript: w('captcha.needsScript'),
        checking: w('captcha.checking'),
        verified: w('captcha.verified'),
        failed: w('captcha.failed'),
        builtIn: w('captcha.builtIn'),
        retry: w('captcha.retry'),
      },
    };
  }

  async #signInForm(
    host: PortalHost,
    locale: HcLocale,
    state: {
      email: string;
      error: SignInError | null;
      next: string | null;
      status: number;
    },
  ): Promise<PortalResponse> {
    const t = translator(locale);
    const nonce = this.#nonce(host);
    const csrf = csrfToken(this.#deps.csrfKey, nonce.value);
    const pow = await this.#powStrip(host, locale);
    return this.#page(host, locale, {
      titleKey: 'portal.signIn.title',
      status: state.status,
      pow: pow !== null,
      cookies: nonce.cookies,
      main: signInMain({
        t,
        locale,
        action: host.links.base === '' ? '/sign-in' : `${host.links.base}/sign-in`,
        contactHref: host.links.contact(locale),
        email: state.email,
        error: state.error,
        csrf,
        next: state.next,
        pow,
      }),
      query: state.next === null ? {} : { next: state.next },
    });
  }

  async #showSignIn(host: PortalHost): Promise<PortalResponse> {
    const { query } = host.request;
    const locale = host.locale(query.lang);
    return this.#signInForm(host, locale, {
      email: '',
      error: null,
      next: safePortalNext(query.next),
      status: 200,
    });
  }

  async #challenge(host: PortalHost): Promise<PortalResponse> {
    const { brandId } = host;
    if (
      !(await this.#deps.limiter.consume(PORTAL_CHALLENGE_IP_RULE, `${brandId}:${host.request.ip}`))
    ) {
      return host.json(429, {
        statusCode: 429,
        message: 'Too many challenges from here; wait a few minutes',
      });
    }
    const challenge = await this.#deps.captcha.challenge(brandId);
    return challenge === null
      ? host.json(404, { statusCode: 404, message: 'No built-in check here' })
      : host.json(200, captchaChallengeSchema.parse(challenge));
  }

  // ---------------------------------------------------------------- requesting a link

  async #requestLink(host: PortalHost): Promise<PortalResponse> {
    const form: PortalSignInForm | null = ok(
      portalSignInFormSchema.safeParse(host.request.body ?? {}),
    );
    if (form === null) {
      return host.plain(400, 'Bad request');
    }
    const locale = host.locale(form.lang);
    const next = safePortalNext(form.next);
    const nonce = host.request.cookies[this.#names(host).nonce];
    if (!csrfValid(this.#deps.csrfKey, nonce, form.csrf)) {
      return this.#stale(host, locale, 'csrf');
    }

    const normalised = normaliseEmail(form.email);
    if (!normalised.ok) {
      return this.#signInForm(host, locale, {
        email: form.email,
        error: 'invalid',
        next,
        status: 422,
      });
    }
    const email = normalised.value;

    if (
      (await this.#deps.captcha.required(host.brandId)) &&
      !(await this.#deps.captcha.spend(host.brandId, form.hd_pow ?? ''))
    ) {
      this.#deps.log.warn(
        { securityEvent: 'portal.sign_in.captcha_refused', brandId: host.brandId },
        'customer portal security event',
      );
      return this.#signInForm(host, locale, { email, error: 'captcha', next, status: 422 });
    }

    const { limiter } = this.#deps;
    const withinIp = await limiter.consume(
      PORTAL_LINK_IP_RULE,
      `${host.brandId}:${host.request.ip}`,
    );
    const withinEmail = await limiter.consume(PORTAL_LINK_EMAIL_RULE, `${host.brandId}:${email}`);
    if (!withinIp || !withinEmail) {
      this.#deps.log.warn(
        { securityEvent: 'portal.sign_in.rate_limited', brandId: host.brandId },
        'customer portal security event',
      );
      return this.#signInForm(host, locale, { email, error: 'tooMany', next, status: 429 });
    }

    const token = newToken();
    const now = this.#now();
    const confirmUrl = (value: string): string => {
      const url = new URL(host.links.url(host.links.portalConfirm()));
      url.searchParams.set('token', value);
      url.searchParams.set('lang', locale);
      if (next !== null) {
        url.searchParams.set('next', next);
      }
      return url.toString();
    };

    const response = this.#page(host, locale, {
      titleKey: 'portal.sent.title',
      main: sentMain({
        t: translator(locale),
        email,
        signInHref: host.links.portalSignIn(locale, next ?? undefined),
      }),
    });
    // Everything that depends on whether the address is a customer runs after the response.
    return {
      ...response,
      after: async () => {
        try {
          await this.#deps.store.issueLink({
            brandId: host.brandId,
            email,
            locale,
            token,
            tokenHash: hashToken(token),
            confirmUrl,
            now,
          });
        } catch (error) {
          this.#deps.log.warn(
            { brandId: host.brandId, error: error instanceof Error ? error.name : 'unknown' },
            'customer portal: a sign-in link could not be issued',
          );
        }
      },
    };
  }

  // ---------------------------------------------------------------- the Continue page

  async #confirmBudget(host: PortalHost): Promise<boolean> {
    return this.#deps.limiter.consume(PORTAL_CONFIRM_IP_RULE, `${host.brandId}:${host.request.ip}`);
  }

  #dead(host: PortalHost, locale: HcLocale, kind: 'expired' | 'used'): PortalResponse {
    this.#deps.log.info(
      { securityEvent: `portal.link.${kind}`, brandId: host.brandId },
      'customer portal security event',
    );
    return this.#page(host, locale, {
      titleKey: `portal.${kind}.title`,
      status: 410,
      main: deadLinkMain({
        t: translator(locale),
        kind,
        signInHref: host.links.portalSignIn(locale),
        ticketsHref: host.links.portalTickets(locale),
      }),
    });
  }

  #stale(host: PortalHost, locale: HcLocale, why: 'csrf'): PortalResponse {
    this.#deps.log.warn(
      { securityEvent: `portal.${why}.refused`, brandId: host.brandId },
      'customer portal security event',
    );
    return this.#page(host, locale, {
      titleKey: 'portal.stale.title',
      status: 403,
      main: staleMain({ t: translator(locale), signInHref: host.links.portalSignIn(locale) }),
    });
  }

  async #showConfirm(host: PortalHost): Promise<PortalResponse> {
    const { query } = host.request;
    const locale = host.locale(query.lang);
    if (!(await this.#confirmBudget(host))) {
      return host.plain(429, 'Too many requests');
    }
    if (!isTokenShaped(query.token)) {
      return this.#dead(host, locale, 'expired');
    }
    // Reads only: a mail scanner that opens this page leaves the link working.
    const link = await this.#deps.store.readLink(host.brandId, query.token, this.#now());
    if (link.state !== 'live') {
      return this.#dead(host, locale, link.state);
    }
    const nonce = this.#nonce(host);
    const next = safePortalNext(query.next);
    return this.#page(host, locale, {
      titleKey: 'portal.confirm.title',
      cookies: nonce.cookies,
      query: { token: query.token, ...(next === null ? {} : { next }) },
      main: confirmMain({
        t: translator(locale),
        locale,
        siteName: translator(locale)('siteName.public', { brand: host.config.brandName }),
        email: link.email,
        token: query.token,
        action: host.links.base === '' ? '/sign-in/confirm' : `${host.links.base}/sign-in/confirm`,
        csrf: csrfToken(this.#deps.csrfKey, nonce.value),
        next,
      }),
    });
  }

  async #spendLink(host: PortalHost): Promise<PortalResponse> {
    const form: PortalConfirmForm | null = ok(
      portalConfirmFormSchema.safeParse(host.request.body ?? {}),
    );
    if (form === null) {
      return host.plain(400, 'Bad request');
    }
    const locale = host.locale(form.lang);
    if (!(await this.#confirmBudget(host))) {
      return host.plain(429, 'Too many requests');
    }
    const names = this.#names(host);
    if (!csrfValid(this.#deps.csrfKey, host.request.cookies[names.nonce], form.csrf)) {
      return this.#stale(host, locale, 'csrf');
    }
    if (!isTokenShaped(form.token) || host.request.host === undefined) {
      return this.#dead(host, locale, 'expired');
    }

    const sessionToken = newToken();
    const now = this.#now();
    const outcome = await this.#deps.store.confirm({
      brandId: host.brandId,
      token: form.token,
      sessionTokenHash: hashToken(sessionToken),
      host: host.request.host,
      userAgentFamily: userAgentFamily(host.request.headers.userAgent),
      locale,
      now,
    });
    if (outcome.kind !== 'signed-in') {
      return this.#dead(host, locale, outcome.kind);
    }
    this.#deps.log.info(
      { securityEvent: 'portal.sign_in', brandId: host.brandId, contactId: outcome.contactId },
      'customer portal security event',
    );
    return host.redirect(
      `${host.links.base}${safePortalNext(form.next) ?? '/tickets'}?lang=${locale}`,
      [
        this.#cookie(host, names.session, sessionToken, Math.floor(SESSION_TTL_MS / 1000)),
        this.#cookie(host, names.nonce, '', 0),
      ],
    );
  }

  // ---------------------------------------------------------------- signed in

  #maskedCsrf(live: SignedIn): string {
    return maskCsrf(csrfToken(this.#deps.csrfKey, live.token));
  }

  /**
   * Every page of a signed-in customer goes through here: the session is read
   * once, a missing one sends the customer to sign in and back, and when the
   * store slid the session's expiry the browser's cookie slides with it. The
   * cookie refresh lives only here, so no page can forget it.
   */
  async #signedIn(
    host: PortalHost,
    locale: HcLocale,
    next: string,
    page: (live: SignedIn) => Promise<PortalResponse>,
  ): Promise<PortalResponse> {
    const live = await this.#liveSession(host);
    if (live === null) {
      return host.redirect(host.links.portalSignIn(locale, next));
    }
    const response = await page(live);
    if (!live.session.touched) {
      return response;
    }
    const name = this.#names(host).session;
    return {
      ...response,
      cookies: [
        ...response.cookies.filter((cookie) => cookie.name !== name),
        this.#cookie(host, name, live.token, Math.floor(SESSION_TTL_MS / 1000)),
      ],
    };
  }

  /** The help center's 404, never a 403 and never a different page for "exists but not yours". */
  #missing(host: PortalHost, locale: HcLocale, live: SignedIn): PortalResponse {
    return host.notFound(locale, live.session, this.#maskedCsrf(live));
  }

  async #tickets(host: PortalHost): Promise<PortalResponse> {
    const { query } = host.request;
    const locale = host.locale(query.lang);
    return this.#signedIn(host, locale, '/tickets', async (live) => {
      const { scope } = live.session;
      if (scope === undefined) {
        return host.redirect(host.links.portalSignIn(locale, '/tickets'));
      }
      const listQuery = parseListQuery(query, scope.sees);
      const list = await this.#deps.store.tickets(live.session, listQuery);
      const company = scope.sees === 'account' ? live.session.companyName : null;
      return this.#page(host, locale, {
        titleKey: 'portal.nav.tickets',
        css: PORTAL_CSS + TICKET_CSS,
        live,
        main: ticketListMain({
          t: translator(locale),
          locale,
          timeZone: host.config.timezone,
          now: this.#now(),
          listPath: `${host.links.base}/tickets`,
          ticketPath: (reference) => host.links.portalTicket(reference, locale),
          company,
          scope: listQuery.scope,
          state: listQuery.state,
          q: listQuery.search.kind === 'text' ? listQuery.search.text : '',
          list,
          notice: noticeOf(scope, listQuery, company),
        }),
        query: {
          scope: listQuery.scope === 'company' ? 'company' : undefined,
          state: listQuery.state === 'solved' ? 'solved' : undefined,
          q: listQuery.search.kind === 'text' ? listQuery.search.text : undefined,
        },
      });
    });
  }

  /** `/tickets/<ref>` and `/tickets/<ref>/attachments/<id>`; any other shape under `/tickets/` is a 404. */
  async #ticketRoute(host: PortalHost): Promise<PortalResponse> {
    const locale = host.locale(host.request.query.lang);
    const parts = host.path.split('/').slice(2);
    const rawReference = parts[0] ?? '';
    const isTicket = parts.length === 1;
    const isFile = parts.length === 3 && parts[1] === 'attachments';
    return this.#signedIn(host, locale, host.path, async (live) => {
      const reference = parseTicketReference(rawReference);
      if (reference === null || !(isTicket || isFile)) {
        return this.#missing(host, locale, live);
      }
      return isFile
        ? this.#file(host, locale, live, reference, parts[2] ?? '')
        : this.#ticket(host, locale, live, reference);
    });
  }

  async #ticket(
    host: PortalHost,
    locale: HcLocale,
    live: SignedIn,
    reference: TicketReference,
  ): Promise<PortalResponse> {
    const found = await this.#deps.store.ticket(live.session, reference);
    if (found.kind === 'missing') {
      return this.#missing(host, locale, live);
    }
    if (found.kind === 'moved') {
      return host.redirect(host.links.portalTicket(found.reference, locale));
    }
    return this.#page(host, locale, {
      titleKey: 'portal.nav.tickets',
      css: PORTAL_CSS + TICKET_CSS,
      live,
      main: ticketMain({
        t: translator(locale),
        locale,
        timeZone: host.config.timezone,
        brandName: host.config.brandName,
        listHref: host.links.portalTickets(locale),
        attachmentPath: (ref, id) => host.links.portalAttachment(ref, id),
        ticket: found.ticket,
      }),
    });
  }

  /** A file is a redirect to its short-lived address, or the 404 that every refusal shares. */
  async #file(
    host: PortalHost,
    locale: HcLocale,
    live: SignedIn,
    reference: TicketReference,
    attachmentId: string,
  ): Promise<PortalResponse> {
    if (!UUID.test(attachmentId)) {
      return this.#missing(host, locale, live);
    }
    const file = await this.#deps.store.attachment(live.session, reference, attachmentId);
    return file === null ? this.#missing(host, locale, live) : host.redirect(file.url);
  }

  async #signOut(host: PortalHost, everywhere: boolean): Promise<PortalResponse> {
    const form: PortalSessionForm | null = ok(
      portalSessionFormSchema.safeParse(host.request.body ?? {}),
    );
    if (form === null) {
      return host.plain(400, 'Bad request');
    }
    const locale = host.locale(form.lang);
    const names = this.#names(host);
    const live = await this.#liveSession(host);
    const home = host.links.home(locale);
    if (live === null) {
      // Nothing to end; clear whatever stale cookie is there.
      return host.redirect(home, [this.#cookie(host, names.session, '', 0)]);
    }
    if (!csrfValid(this.#deps.csrfKey, live.token, form.csrf)) {
      return this.#stale(host, locale, 'csrf');
    }
    if (everywhere) {
      await this.#deps.store.endAllSessions(host.brandId, live.session.contactId);
    } else {
      await this.#deps.store.endSession(host.brandId, live.session.id);
    }
    this.#deps.log.info(
      {
        securityEvent: everywhere ? 'portal.sign_out_everywhere' : 'portal.sign_out',
        brandId: host.brandId,
        contactId: live.session.contactId,
      },
      'customer portal security event',
    );
    return host.redirect(home, [this.#cookie(host, names.session, '', 0)]);
  }
}

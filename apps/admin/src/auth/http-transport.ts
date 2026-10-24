import type {
  AiRefusal,
  AssistRefusal,
  AuthErrorBody,
  ChannelsRefusal,
  ContactRefusal,
  DomainsRefusal,
  HcRefusal,
  IdentityProblem,
  KnowledgeRefusal,
  MetaRefusal,
  MetaRefusalDetails,
  SsoRefusal,
  StaffRefusal,
  TelegramRefusal,
  TicketingRefusal,
  TicketLifecycleRefusal,
  WebhooksRefusal,
} from '@helpdock/schemas';
import { authSessionResponseSchema, errorResponseSchema } from '@helpdock/schemas';
import { AiError } from '../ai/api.js';
import { AssistError } from '../assist/api.js';
import { ChannelsError } from '../channels/api.js';
import { ContactError } from '../contacts/api.js';
import { WebhooksError } from '../developers/api.js';
import { DomainsError } from '../domains/api.js';
import { SmtpPasswordRequiredError } from '../email/api.js';
import { HelpCenterError } from '../help-center/api.js';
import { KnowledgeError } from '../knowledge/api.js';
import { MetaError } from '../meta/api.js';
import { SsoError } from '../sso/api.js';
import { StaffError } from '../staff/api.js';
import { TelegramError } from '../telegram/api.js';
import { TicketingError } from '../ticketing/api.js';
import { TicketLifecycleError } from '../tickets/api.js';
import { AuthError } from './api.js';

/**
 * The one connection to the api: the access token, the refresh, and the rule
 * for turning a failed response into an error the screens can react to.
 *
 * It is its own object because more than one adapter speaks to the api and they
 * must share a token. `HttpAuthApi` signs in and `HttpStaffApi` manages people;
 * two transports would mean two tokens, one of which would always be the stale
 * one after a refresh.
 *
 * **The access token lives in a field here and nowhere else.** Not in
 * `localStorage`, not in `sessionStorage`, not in a cookie a script can read:
 * those survive a tab being closed and are readable by anything injected into
 * the page, and a ten-minute token that survives neither is worth much less to
 * an attacker. A reload starts with no token and calls `refresh()`, which is
 * what the `httpOnly` cookie is for.
 *
 * **A 401 is retried exactly once, and only when it refused the token.** The
 * auth guard's 401 means the token sent has expired, so the transport refreshes
 * and repeats the request; a second 401 means the session is gone and retrying
 * again would be a loop. A 401 that carries `error.auth` refused something in
 * the body instead — a sign-in, or the password or code a step-up asks for —
 * and a refresh cannot change that answer. Repeating it would spend a second
 * attempt against the step-up limit (#271), so it reaches the screen unchanged,
 * as does any 401 to a request that sent no token.
 */
/**
 * How long before a token's stated expiry it counts as spent. A socket
 * handshake that arrives a second after the token died is refused, and the
 * reconnect that follows would ask for the same dead token again.
 */
const EXPIRY_SKEW_MS = 30_000;

/** A 204, or any answer that says it is empty: `json()` throws on an empty body. */
const hasNoContent = (response: Response): boolean =>
  response.status === 204 || response.headers.get('content-length') === '0';

export class HttpTransport {
  readonly #baseUrl: string;
  #accessToken: string | null = null;
  #expiresAt = 0;
  /** In-flight refresh, so ten requests failing at once produce one refresh. */
  #refreshing: Promise<boolean> | null = null;

  constructor(baseUrl = '/api') {
    this.#baseUrl = baseUrl;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get accessToken(): string | null {
    return this.#accessToken;
  }

  set accessToken(token: string | null) {
    this.#accessToken = token;
    this.#expiresAt = 0;
  }

  /** A token and the moment it dies, which the api states on every issue. */
  keepSession(issued: { readonly accessToken: string; readonly expiresInSeconds: number }): void {
    this.#accessToken = issued.accessToken;
    this.#expiresAt = Date.now() + issued.expiresInSeconds * 1000;
  }

  /**
   * A token that is still current, refreshing first when there is none or when
   * the one held is about to expire.
   *
   * The expiry check is what makes the realtime client's reconnect loop work:
   * nothing about a WebSocket handshake produces the 401 that clears the token
   * on the HTTP path, so without it a reconnect an hour later would present the
   * same dead token for ever.
   */
  async currentAccessToken(): Promise<string | null> {
    if (this.#accessToken === null || Date.now() >= this.#expiresAt - EXPIRY_SKEW_MS) {
      await this.refresh();
    }

    return this.#accessToken;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    { retry = true, signal }: { readonly retry?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const sent = this.#accessToken;
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      // The refresh cookie is `SameSite=Lax` and the admin is served from the
      // same origin as the api, so this is what carries it.
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        // A form is sent as it is: the browser writes its own multipart
        // boundary into the content type, and a JSON one here would break it.
        ...(body === undefined || body instanceof FormData
          ? {}
          : { 'content-type': 'application/json' }),
        ...(sent === null ? {} : { authorization: `Bearer ${sent}` }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (retry && sent !== null && (await refusedTheToken(response))) {
      this.accessToken = null;
      if (await this.refresh()) {
        return this.request(method, path, body, { retry: false, ...(signal ? { signal } : {}) });
      }
    }

    if (!response.ok) {
      throw await toError(response);
    }

    // A 202 or 200 the api answers without a body (a queued test push) has
    // nothing for `json()` to read; it would throw on the empty string.
    return hasNoContent(response) ? undefined : response.json();
  }

  /**
   * A `GET` whose answer is bytes rather than JSON: M2-07's remote-image
   * proxy. Same token, same refresh, same error mapping as {@link request}.
   */
  async requestBlob(
    path: string,
    { retry = true }: { readonly retry?: boolean } = {},
  ): Promise<Blob> {
    const sent = this.#accessToken;
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: sent === null ? {} : { authorization: `Bearer ${sent}` },
    });

    if (retry && sent !== null && (await refusedTheToken(response))) {
      this.accessToken = null;
      if (await this.refresh()) {
        return this.requestBlob(path, { retry: false });
      }
    }

    if (!response.ok) {
      throw await toError(response);
    }

    return response.blob();
  }

  async refresh(): Promise<boolean> {
    this.#refreshing ??= this.#refreshOnce().finally(() => {
      this.#refreshing = null;
    });

    return this.#refreshing;
  }

  async #refreshOnce(): Promise<boolean> {
    const response = await fetch(`${this.#baseUrl}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      return false;
    }

    const parsed = authSessionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return false;
    }

    this.keepSession(parsed.data);
    return true;
  }
}

/**
 * Whether a response is the auth guard refusing the bearer token, the one 401 a
 * refresh can cure. Every refusal of a credential in the body carries
 * `error.auth`; the guard's never does. A body that is not the api's — a
 * proxy's page — says nothing either way and is treated as the token, as before.
 */
const refusedTheToken = async (response: Response): Promise<boolean> => {
  if (response.status !== 401) {
    return false;
  }

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return true;
    }
    throw error;
  }

  const parsed = errorResponseSchema.safeParse(body);
  return !parsed.success || parsed.data.error.auth === undefined;
};

/**
 * Turns a failed response into the error its screen understands. The api puts
 * the detail in `error.auth`, `error.staff`, `error.contact` or
 * `error.ticketing`; anything else —
 * a proxy's HTML error page, a network failure — is `unavailable`, because the
 * screens have exactly one sentence for "something went wrong".
 */
const toError = async (
  response: Response,
): Promise<
  | AssistError
  | AiError
  | AuthError
  | ChannelsError
  | ContactError
  | DomainsError
  | HelpCenterError
  | KnowledgeError
  | MetaError
  | SmtpPasswordRequiredError
  | SsoError
  | StaffError
  | TelegramError
  | TicketingError
  | TicketLifecycleError
  | WebhooksError
> => {
  let auth: AuthErrorBody | undefined;
  let staff: StaffRefusal | undefined;
  let contact: { reason: ContactRefusal; problem?: IdentityProblem | undefined } | undefined;
  let ticketing: { reason: TicketingRefusal; count?: number | undefined } | undefined;
  let lifecycle:
    | {
        reason: TicketLifecycleRefusal;
        fields?: string[] | undefined;
      }
    | undefined;
  let channels: ChannelsRefusal | undefined;
  let domains: DomainsRefusal | undefined;
  let helpCenter: HcRefusal | undefined;
  let ai: AiRefusal | undefined;
  let knowledge: KnowledgeRefusal | undefined;
  let telegram: TelegramRefusal | undefined;
  let meta: { reason: MetaRefusal; details?: MetaRefusalDetails | undefined } | undefined;
  let assist: AssistRefusal | undefined;
  let webhooks: { reason: WebhooksRefusal; address?: string | undefined } | undefined;
  let sso: { reason: SsoRefusal; domains?: string[] | undefined } | undefined;
  let smtpPasswordRequired = false;

  try {
    const body = errorResponseSchema.parse(await response.json()).error;
    auth = body.auth;
    staff = body.staff?.reason;
    contact = body.contact;
    ticketing = body.ticketing;
    lifecycle = body.lifecycle;
    channels = body.channels?.reason;
    domains = body.domains?.reason;
    helpCenter = body.helpCenter?.reason;
    ai = body.ai?.reason;
    knowledge = body.knowledge?.reason;
    telegram = body.telegram?.reason;
    meta = body.meta;
    assist = body.assist?.reason;
    webhooks = body.webhooks;
    sso = body.sso;
    smtpPasswordRequired = body.setup?.reason === 'smtp-password-required';
  } catch {
    // An HTML error page from a proxy, or a network failure: no error body to
    // read, and `unavailable` is the answer below.
  }

  if (contact !== undefined) {
    return new ContactError(contact.reason, contact.problem);
  }

  if (staff !== undefined) {
    return new StaffError(staff);
  }

  if (ticketing !== undefined) {
    return new TicketingError(ticketing.reason, ticketing.count);
  }

  if (lifecycle !== undefined) {
    return new TicketLifecycleError(lifecycle.reason, lifecycle.fields);
  }

  if (channels !== undefined) {
    return new ChannelsError(channels);
  }

  if (domains !== undefined) {
    return new DomainsError(domains);
  }

  if (helpCenter !== undefined) {
    return new HelpCenterError(helpCenter);
  }

  if (ai !== undefined) {
    return new AiError(ai);
  }

  if (knowledge !== undefined) {
    return new KnowledgeError(knowledge);
  }

  if (telegram !== undefined) {
    return new TelegramError(telegram);
  }

  if (meta !== undefined) {
    return new MetaError(meta.reason, meta.details);
  }

  if (assist !== undefined) {
    return new AssistError(assist);
  }

  if (webhooks !== undefined) {
    return new WebhooksError(webhooks.reason, webhooks.address);
  }

  if (smtpPasswordRequired) {
    return new SmtpPasswordRequiredError();
  }

  if (sso !== undefined) {
    return new SsoError(sso.reason, sso.domains);
  }

  const retryAfter = Number(response.headers.get('Retry-After'));
  const retryOptions = Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {};
  if (auth === undefined) {
    return new AuthError(response.status === 429 ? 'rate-limited' : 'unavailable', {
      ...retryOptions,
      status: response.status,
    });
  }

  return new AuthError(auth.code, {
    ...retryOptions,
    ...(auth.attemptsLeft === undefined ? {} : { attemptsLeft: auth.attemptsLeft }),
  });
};

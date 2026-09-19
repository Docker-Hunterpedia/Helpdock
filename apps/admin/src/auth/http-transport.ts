import type { AuthErrorBody, StaffRefusal } from '@helpdock/schemas';
import { authSessionResponseSchema, errorResponseSchema } from '@helpdock/schemas';
import { StaffError } from '../staff/api.js';
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
 * **A 401 is retried exactly once, and only when a token was sent.** With a
 * token, a 401 means it expired, so the transport refreshes and repeats the
 * request; a second 401 means the session is gone and retrying again would be a
 * loop. Without a token there is nothing to refresh, and the 401 is the answer
 * itself — a wrong password, a wrong authenticator code — which must reach the
 * screen unchanged.
 */
export class HttpTransport {
  readonly #baseUrl: string;
  #accessToken: string | null = null;
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
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    { retry = true }: { readonly retry?: boolean } = {},
  ): Promise<unknown> {
    const sent = this.#accessToken;
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      // The refresh cookie is `SameSite=Lax` and the admin is served from the
      // same origin as the api, so this is what carries it.
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(sent === null ? {} : { authorization: `Bearer ${sent}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 401 && retry && sent !== null) {
      this.#accessToken = null;
      if (await this.refresh()) {
        return this.request(method, path, body, { retry: false });
      }
    }

    if (!response.ok) {
      throw await toError(response);
    }

    return response.status === 204 ? undefined : response.json();
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

    this.#accessToken = parsed.data.accessToken;
    return true;
  }
}

/**
 * Turns a failed response into the error its screen understands. The api puts
 * the detail in `error.auth` or `error.staff`; anything else — a proxy's HTML
 * error page, a network failure — is `unavailable`, because the screens have
 * exactly one sentence for "something went wrong".
 */
const toError = async (response: Response): Promise<AuthError | StaffError> => {
  let auth: AuthErrorBody | undefined;
  let staff: StaffRefusal | undefined;

  try {
    const body = errorResponseSchema.parse(await response.json()).error;
    auth = body.auth;
    staff = body.staff?.reason;
  } catch {
    // An HTML error page from a proxy, or a network failure: no error body to
    // read, and `unavailable` is the answer below.
  }

  if (staff !== undefined) {
    return new StaffError(staff);
  }

  if (auth === undefined) {
    return new AuthError('unavailable');
  }

  return new AuthError(
    auth.code,
    auth.attemptsLeft === undefined ? {} : { attemptsLeft: auth.attemptsLeft },
  );
};

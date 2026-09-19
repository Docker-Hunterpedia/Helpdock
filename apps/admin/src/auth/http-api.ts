import type {
  AuthErrorBody,
  AuthMethods,
  OauthProvider,
  Session,
  SignInResult,
} from '@helpdock/schemas';
import {
  authMethodsSchema,
  authSessionResponseSchema,
  errorResponseSchema,
  sessionSchema,
  signInResponseSchema,
} from '@helpdock/schemas';
import { type AuthApi, AuthError } from './api.js';

/**
 * The real auth service (M0-05).
 *
 * **The access token lives in a field on this object and nowhere else.** Not in
 * `localStorage`, not in `sessionStorage`, not in a cookie this script can
 * read: those survive a tab being closed and are readable by any script that
 * gets injected, and a ten-minute token that survives neither is worth much
 * less to an attacker. A reload starts with no token and calls `refresh()`,
 * which is what the `httpOnly` cookie is for.
 *
 * **A 401 is retried exactly once, and only when a token was sent.** With a
 * token, a 401 means it expired, so the adapter refreshes and repeats the
 * request; a second 401 means the session is gone and retrying again would be a
 * loop. Without a token there is nothing to refresh, and the 401 is the answer
 * itself — a wrong password or a wrong authenticator code — which must reach
 * the screen unchanged.
 */
export class HttpAuthApi implements AuthApi {
  readonly #baseUrl: string;
  #accessToken: string | null = null;
  /** In-flight refresh, so ten requests failing at once produce one refresh. */
  #refreshing: Promise<boolean> | null = null;

  constructor(baseUrl = '/api') {
    this.#baseUrl = baseUrl;
  }

  async authMethods(): Promise<AuthMethods> {
    return authMethodsSchema.parse(await this.#request('GET', '/auth/methods'));
  }

  async signInWithPassword(email: string, password: string): Promise<SignInResult> {
    const response = signInResponseSchema.parse(
      await this.#request('POST', '/auth/sign-in', { email: email.trim(), password }),
    );

    return this.#keepSession(response);
  }

  async requestMagicLink(email: string): Promise<void> {
    await this.#request('POST', '/auth/magic-link', { email: email.trim() });
  }

  async verifyTotp(
    challengeId: string,
    code: string,
    { trustDevice }: { readonly trustDevice: boolean },
  ): Promise<Session> {
    const result = this.#keepSession(
      signInResponseSchema.parse(
        await this.#request('POST', '/auth/totp', { challengeId, code, trustDevice }),
      ),
    );

    return this.#requireSession(result);
  }

  async useRecoveryCode(challengeId: string, code: string): Promise<Session> {
    const result = this.#keepSession(
      signInResponseSchema.parse(
        await this.#request('POST', '/auth/recovery-code', { challengeId, code }),
      ),
    );

    return this.#requireSession(result);
  }

  oauthStartUrl(provider: OauthProvider): string {
    return `${this.#baseUrl}/auth/oauth/${provider}/start`;
  }

  async exchange(code: string): Promise<Session> {
    const response = authSessionResponseSchema.parse(
      await this.#request('POST', '/auth/exchange', { code }),
    );
    this.#accessToken = response.accessToken;

    return response.session;
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.#request('POST', '/auth/password/forgot', { email: email.trim() });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    await this.#request('POST', '/auth/password/reset', { token, password });
  }

  /**
   * On a cold load there is no token yet, so this refreshes first. A browser
   * with no valid cookie gets `null`, which is what sends it to sign-in.
   */
  async me(): Promise<Session | null> {
    if (this.#accessToken === null && !(await this.#refresh())) {
      return null;
    }

    try {
      return sessionSchema.parse(await this.#request('GET', '/auth/me'));
    } catch (error) {
      if (error instanceof AuthError) {
        return null;
      }
      throw error;
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.#request('POST', '/auth/sign-out');
    } finally {
      // Whatever the server said, this tab is signed out: keeping a token after
      // asking for it to be revoked would be the worst of both.
      this.#accessToken = null;
    }
  }

  // ------------------------------------------------------------------

  #keepSession(response: ReturnType<typeof signInResponseSchema.parse>): SignInResult {
    if (response.kind !== 'session') {
      return response;
    }

    this.#accessToken = response.accessToken;
    return { kind: 'session', session: response.session };
  }

  #requireSession(result: SignInResult): Session {
    if (result.kind !== 'session') {
      // The second factor cannot ask for a second factor, so this is the api
      // and the client disagreeing about the protocol.
      throw new AuthError('unavailable');
    }

    return result.session;
  }

  async #request(
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
      if (await this.#refresh()) {
        return this.#request(method, path, body, { retry: false });
      }
    }

    if (!response.ok) {
      throw await toAuthError(response);
    }

    return response.status === 204 ? undefined : response.json();
  }

  async #refresh(): Promise<boolean> {
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
 * Turns a failed response into an `AuthError`. The api puts the detail the
 * screens need in `error.auth`; anything else — a proxy's HTML error page, a
 * network failure — is `unavailable`, because the screens have exactly one
 * sentence for "something went wrong".
 */
const toAuthError = async (response: Response): Promise<AuthError> => {
  let detail: AuthErrorBody | undefined;
  try {
    detail = errorResponseSchema.parse(await response.json()).error.auth;
  } catch {
    detail = undefined;
  }

  if (detail === undefined) {
    return new AuthError('unavailable');
  }

  return new AuthError(
    detail.code,
    detail.attemptsLeft === undefined ? {} : { attemptsLeft: detail.attemptsLeft },
  );
};

import type { AuthApi } from './api.js';
import type { OauthProvider, Session, SignInResult } from './schemas.js';

const NOT_IMPLEMENTED = 'not implemented until M0-05';

/**
 * The wiring point for the real auth service. M0-05 (#8) fills these in against
 * the endpoints documented in `apps/admin/README.md`, validating every response
 * with the schemas in `./schemas.ts`. Until then the app is built with
 * `VITE_AUTH_API=mock` and this adapter only exists so that switch has
 * somewhere to point.
 */
export class HttpAuthApi implements AuthApi {
  readonly #baseUrl: string;

  constructor(baseUrl = '/api') {
    this.#baseUrl = baseUrl;
  }

  signInWithPassword(_email: string, _password: string): Promise<SignInResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  requestMagicLink(_email: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  verifyTotp(
    _challengeId: string,
    _code: string,
    _options: { readonly trustDevice: boolean },
  ): Promise<Session> {
    throw new Error(NOT_IMPLEMENTED);
  }

  useRecoveryCode(_challengeId: string, _code: string): Promise<Session> {
    throw new Error(NOT_IMPLEMENTED);
  }

  oauthStartUrl(provider: OauthProvider): string {
    return `${this.#baseUrl}/auth/oauth/${provider}/start`;
  }

  me(): Promise<Session | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  signOut(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}

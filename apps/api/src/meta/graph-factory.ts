import { type GraphApi, type GraphClient, graphApiFor } from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { MetaAccount as MetaAccountRow } from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';
import type { GraphClientFactory } from './graph-client-factory.js';

/**
 * Graph calls made with one token (M10-07). The shared client is stateless and
 * every call names its token; the routes, the refresh and the health job each
 * hold a token for a few statements, and this keeps it where nothing can log it:
 * a private field of a class that serialises to its platform and nothing else.
 * The only paths a token leaves by are the `Authorization` header and the two
 * Graph calls that take it as a parameter, which are methods here rather than
 * a `query` a caller builds.
 *
 * `GraphClientFactory` itself is `graph-client-factory.ts`'s, the seam M10-02
 * left; this file is what turns it and a stored account into something a
 * service can call.
 */

export type { GraphClientFactory };

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export class AccountGraph {
  readonly platform: MetaPlatform;
  readonly #client: GraphClient;
  readonly #token: string;
  readonly #api: GraphApi;

  constructor(client: GraphClient, platform: MetaPlatform, token: string, api?: GraphApi) {
    this.platform = platform;
    this.#client = client;
    this.#token = token;
    this.#api = api ?? graphApiFor(platform);
  }

  get(path: string, query?: Query): Promise<unknown> {
    return this.#client.get(path, {
      token: this.#token,
      api: this.#api,
      ...(query === undefined ? {} : { query }),
    });
  }

  post(
    path: string,
    options: { readonly query?: Query; readonly json?: unknown } = {},
  ): Promise<unknown> {
    return this.#client.post(path, { token: this.#token, api: this.#api, ...options });
  }

  delete(path: string, query?: Query): Promise<unknown> {
    return this.#client.delete(path, {
      token: this.#token,
      api: this.#api,
      ...(query === undefined ? {} : { query }),
    });
  }

  /** The same token on the other Graph host, to ask whether it is a token for the other product. */
  onOtherHost(): AccountGraph {
    return new AccountGraph(
      this.#client,
      this.platform,
      this.#token,
      this.#api === 'instagram' ? 'graph' : 'instagram',
    );
  }

  /**
   * `GET /debug_token`: the token asks about itself, which is the one call
   * that carries it as a parameter. Not on the Instagram host, which has no
   * such edge.
   */
  debugToken(): Promise<unknown> {
    return this.#client.get('/debug_token', {
      token: this.#token,
      api: this.#api,
      query: { input_token: this.#token },
    });
  }

  /**
   * `GET /refresh_access_token`: an Instagram user token good for another 60
   * days. Instagram's edge reads the token as a parameter, so the bearer is
   * sent as well and the stand-in and Meta both find it.
   */
  refreshInstagramToken(): Promise<unknown> {
    return this.#client.get('/refresh_access_token', {
      token: this.#token,
      api: 'instagram',
      query: { grant_type: 'ig_refresh_token', access_token: this.#token },
    });
  }

  toJSON(): { readonly platform: MetaPlatform } {
    return { platform: this.platform };
  }
}

/** The calls for a stored account: its token is decrypted here and nowhere it could be logged. */
export const graphForAccount = (
  account: Pick<MetaAccountRow, 'platform' | 'accessToken'>,
  keyring: Keyring,
  factory: GraphClientFactory,
): AccountGraph =>
  new AccountGraph(factory(), account.platform, decryptSecret(account.accessToken, keyring));

/** The calls for a token the person just typed, before anything is stored. */
export const graphForToken = (
  platform: MetaPlatform,
  token: string,
  factory: GraphClientFactory,
): AccountGraph => new AccountGraph(factory(), platform, token);

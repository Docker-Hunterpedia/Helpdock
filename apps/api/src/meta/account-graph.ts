import {
  type GraphApi,
  type GraphClient,
  type GraphDownload,
  type GraphUpload,
  graphApiFor,
  redactToken,
} from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { MetaAccount as MetaAccountRow } from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';

/**
 * Graph calls made with one token (M10-07). The shared client is stateless and
 * every call names its token; the routes and the jobs hold a token for a few
 * statements, and this keeps it where nothing can log it: a private field of a
 * class that serialises to its platform and nothing else. The only paths a
 * token leaves by are the `Authorization` header and `debug_token`, the one
 * Graph call that takes it as a parameter, which is a method here rather than a
 * `query` a caller builds. A caller that has to take the token out of a message
 * does it with {@link AccountGraph.redact}, never with the token.
 *
 * {@link graphForAccount} is the one place a stored token is decrypted: every
 * route and job that talks to Meta for an account does it through this class,
 * so the token-handling rule has one implementation.
 */

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

  /** `POST` of one file and its text fields, as `POST /{phone-number-id}/media` wants. */
  postMultipart(
    path: string,
    upload: { readonly fields: Readonly<Record<string, string>>; readonly file: GraphUpload },
  ): Promise<unknown> {
    return this.#client.postMultipart(path, { token: this.#token, api: this.#api, ...upload });
  }

  /**
   * The bytes at a URL Graph named (a WhatsApp media URL). The client sends the
   * token only to a Graph root and Meta's media host, whatever the URL is.
   */
  download(
    url: string,
    limits: { readonly maxBytes: number; readonly timeoutMs?: number },
  ): Promise<GraphDownload> {
    return this.#client.download(url, { token: this.#token, ...limits });
  }

  /** The bytes at a link a webhook carried (a Messenger or Instagram attachment): no token. */
  downloadLink(
    url: string,
    limits: { readonly maxBytes: number; readonly timeoutMs?: number },
  ): Promise<GraphDownload> {
    return this.#client.download(url, limits);
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

  /** `text` with this token taken out, for a line that is stored or logged. */
  redact(text: string): string {
    return redactToken(text, this.#token);
  }

  toJSON(): { readonly platform: MetaPlatform } {
    return { platform: this.platform };
  }
}

/** The calls for a stored account: its token is decrypted here and nowhere it could be logged. */
export const graphForAccount = (
  account: Pick<MetaAccountRow, 'platform' | 'accessToken'>,
  keyring: Keyring,
  client: GraphClient,
): AccountGraph =>
  new AccountGraph(client, account.platform, decryptSecret(account.accessToken, keyring));

/** The calls for a token the person just typed, before anything is stored. */
export const graphForToken = (
  platform: MetaPlatform,
  token: string,
  client: GraphClient,
): AccountGraph => new AccountGraph(client, platform, token);

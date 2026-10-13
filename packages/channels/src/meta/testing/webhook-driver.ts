import { metaWebhookPath } from '@helpdock/schemas';
import { type MetaWebhookBody, type WhatsAppStatusInput, whatsappStatus } from '../fixtures.js';
import { hubSignature } from '../signature.js';

/**
 * The signed-webhook driver (M10-01): posts a fixture to the install's
 * `/api/meta/webhook` as Meta would, signed with the test app's secret, or with
 * a wrong one, or not at all. The stand-in for Graph (`fake-graph.ts`) emits
 * nothing by itself; this is how a test says when Meta posted.
 *
 * It talks to a {@link WebhookTarget}: the Nest app's `inject` in the api's
 * suites, or {@link httpWebhookTarget} for a server listening on a port.
 */

export interface WebhookInjectOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly payload?: Buffer | string;
}

/** What `NestFastifyApplication.inject` and `light-my-request` answer with. */
export interface WebhookInjectResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface WebhookTarget {
  inject(options: WebhookInjectOptions): PromiseLike<WebhookInjectResponse>;
}

/** A {@link WebhookTarget} that sends real HTTP to `baseUrl`, for a server on a port. */
export const httpWebhookTarget = (baseUrl: string): WebhookTarget => ({
  inject: async ({ method, url, headers, payload }) => {
    // Test-only driver: the base URL is the server under test on a loopback
    // port, chosen by the test itself, never a URL a user supplied.
    // nosemgrep: helpdock-fetch-non-constant-url
    const response = await fetch(new URL(url, baseUrl), {
      method,
      ...(headers === undefined ? {} : { headers }),
      ...(payload === undefined ? {} : { body: payload }),
    });

    return { statusCode: response.status, body: await response.text() };
  },
});

export interface WebhookResponse {
  readonly status: number;
  readonly body: string;
}

export interface PostOptions {
  /** Signs with this secret instead of the driver's: a wrong one for a refusal test. */
  readonly secret?: string;
  /**
   * The signature header to send: a string verbatim (a malformed one), or null
   * for none at all. Absent, the header is the right signature of the body.
   */
  readonly header?: string | null;
  /** Changes the bytes after they are signed, as a man in the middle would. */
  readonly tamper?: (raw: Buffer) => Buffer;
}

export interface MetaWebhookDriverOptions {
  readonly target: WebhookTarget;
  /** The test app's secret: `meta.appSecret`, or `meta.instagramAppSecret` for Instagram. */
  readonly secret: string;
  /** Default {@link metaWebhookPath}. */
  readonly path?: string;
}

/**
 * Joins webhook bodies of one `object` into a single envelope with all their
 * entries, in order: what Meta does when several accounts have something to
 * say in the same instant. Bodies of different objects cannot share an envelope.
 */
export const batchOf = (...bodies: readonly MetaWebhookBody[]): MetaWebhookBody => {
  const [first] = bodies;
  if (first === undefined) {
    throw new TypeError('A batch has at least one body');
  }
  if (bodies.some((body) => body.object !== first.object)) {
    throw new TypeError('A batch is one object: whatsapp_business_account, page or instagram');
  }

  return { ...first, entry: bodies.flatMap((body) => body.entry as unknown[]) };
};

export class MetaWebhookDriver {
  readonly #target: WebhookTarget;
  readonly #secret: string;
  readonly #path: string;

  constructor({ target, secret, path = metaWebhookPath() }: MetaWebhookDriverOptions) {
    this.#target = target;
    this.#secret = secret;
    this.#path = path;
  }

  /** The bytes that are signed and posted: the JSON of the body, compact, as Meta writes it. */
  raw(body: MetaWebhookBody): Buffer {
    return Buffer.from(JSON.stringify(body), 'utf8');
  }

  /** The `X-Hub-Signature-256` of `raw` under the driver's secret, or `secret`. */
  signature(raw: Buffer, secret: string = this.#secret): string {
    return hubSignature(raw, secret);
  }

  /** Posts a body as Meta would and answers with what the route said. */
  async post(body: MetaWebhookBody, options: PostOptions = {}): Promise<WebhookResponse> {
    const signed = this.raw(body);
    const sent = options.tamper === undefined ? signed : options.tamper(signed);
    const header =
      options.header === undefined ? this.signature(signed, options.secret) : options.header;

    const response = await this.#target.inject({
      method: 'POST',
      url: this.#path,
      headers: {
        'content-type': 'application/json',
        ...(header === null ? {} : { 'x-hub-signature-256': header }),
      },
      payload: sent,
    });

    return { status: response.statusCode, body: response.body };
  }

  /** Posts several bodies of one object as one envelope. */
  postBatch(
    bodies: readonly MetaWebhookBody[],
    options: PostOptions = {},
  ): Promise<WebhookResponse> {
    return this.post(batchOf(...bodies), options);
  }

  /**
   * The WhatsApp `statuses[]` body for a message Helpdock sent: `delivered`
   * and `read` as Meta reports them, `failed` with its code. Pass the `wamid`
   * the stand-in answered the send with.
   */
  statusFor(delivery: WhatsAppStatusInput): MetaWebhookBody {
    return whatsappStatus(delivery);
  }

  /** Posts the status report of a sent message. */
  postStatus(delivery: WhatsAppStatusInput, options: PostOptions = {}): Promise<WebhookResponse> {
    return this.post(this.statusFor(delivery), options);
  }

  /**
   * The callback-URL handshake Meta makes when the URL or the verify token is
   * saved in its dashboard: `GET` with `hub.mode`, `hub.verify_token` and
   * `hub.challenge`. The answer's body is the challenge when it was accepted.
   */
  async handshake(parameters: {
    readonly verifyToken: string;
    readonly challenge: string;
    readonly mode?: string;
  }): Promise<WebhookResponse> {
    const query = new URLSearchParams({
      'hub.mode': parameters.mode ?? 'subscribe',
      'hub.verify_token': parameters.verifyToken,
      'hub.challenge': parameters.challenge,
    });
    const response = await this.#target.inject({
      method: 'GET',
      url: `${this.#path}?${query.toString()}`,
    });

    return { status: response.statusCode, body: response.body };
  }
}

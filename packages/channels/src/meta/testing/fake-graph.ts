import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { META_SUBSCRIBED_FIELDS, type MetaPlatform } from '@helpdock/schemas';
import {
  fixtureMid,
  fixtureWamid,
  graphPairRateLimited,
  graphSubscribedApp,
  graphTokenExpired,
  graphUserUnavailable,
  graphWindowClosed,
  sha256Hex,
} from '../fixtures.js';
import {
  type MessagingSendPayload,
  messagingSendPayloadSchema,
  sendPayloadText,
  type WhatsAppSendPayload,
  whatsappSendPayloadSchema,
} from '../send-payloads.js';

/**
 * A local HTTP server standing in for the Graph API (M10-01), as
 * `FakeTelegram` stands in for api.telegram.org. The Meta suites point
 * `META_GRAPH_API_ROOT` at `facebookRoot` and `META_INSTAGRAM_API_ROOT` at
 * `instagramRoot` (and allow 127.0.0.0/8 in `OUTBOUND_ALLOW_CIDRS`, which is how
 * `safeFetch` reaches it): it answers the calls Helpdock makes, records every
 * one, serves media, checks the bodies Helpdock sends against
 * `send-payloads.ts` and the platforms' text limits, and can be told to refuse
 * a customer the way Meta does.
 *
 * It emits nothing by itself: webhooks come from the driver
 * (`webhook-driver.ts`), so a test says exactly when Meta would have posted.
 *
 * Two roots, one server: a token registered for a WhatsApp number or a Page is
 * good on `facebookRoot` only, an Instagram token on `instagramRoot` only, as
 * on Meta, so a call sent to the wrong host fails the way it would in production.
 */

export type FakeGraphRoot = 'facebook' | 'instagram';

/** One request the stand-in served. */
export interface GraphCall {
  /** Which root served it. */
  readonly root: FakeGraphRoot;
  readonly method: string;
  /** After the version: `/106540352242922/messages`. */
  readonly path: string;
  /** `v25.0`. */
  readonly version: string;
  /** From `Authorization: Bearer` or `access_token`, or null. */
  readonly token: string | null;
  readonly query: Readonly<Record<string, string>>;
  /** The parsed JSON body, `{ fields, file }` for an upload, or null. */
  readonly body: unknown;
}

/** A WhatsApp number, a Page or an Instagram account the stand-in knows. */
export interface FakeGraphAccount {
  readonly platform: MetaPlatform;
  /** The phone number id, the Page id or the Instagram account id. */
  readonly id: string;
  /** The verified name, the Page's name or the account's name. */
  readonly name: string;
  readonly username?: string;
  readonly displayPhone?: string;
  /**
   * WhatsApp: the business account the number belongs to, required. Meta keeps
   * the webhook subscription (`/{waba}/subscribed_apps`), the list of numbers
   * (`/{waba}/phone_numbers`) and the templates under it, and answers an
   * unsupported-edge error for the same paths on the number's own id.
   */
  readonly wabaId?: string;
  /** WhatsApp: the rating `GET /{waba}/phone_numbers` reports, such as `GREEN`. */
  readonly qualityRating?: string;
}

/** An uploaded file as the stand-in records it. */
export interface FakeUpload {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

/** A message the stand-in accepted. */
export interface FakeSentMessage {
  readonly accountId: string;
  readonly platform: MetaPlatform;
  /** The id the stand-in answered with. */
  readonly id: string;
  /** The recipient: a number or user id on WhatsApp, a PSID or IGSID otherwise. */
  readonly to: string;
  readonly payload: unknown;
}

/** A refusal queued for the next request that matches. */
export interface FakeFailure {
  readonly status: number;
  readonly body?: unknown;
  /** Response headers, such as the `location` of a redirect. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Only requests whose `METHOD /path` matches; any request when absent. */
  readonly match?: RegExp;
}

interface TokenFacts {
  readonly ids: ReadonlySet<string>;
  readonly root: FakeGraphRoot;
  readonly kind: string;
  /** Unix seconds; 0 for a token that does not expire. */
  expiresAt: number;
}

interface FakeSubscription {
  readonly appId: string;
  readonly name: string;
  readonly fields: readonly string[];
}

interface Answer {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: Buffer;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A request for media bytes, which Graph's own routes do not carry. */
export interface FakeMediaRequest {
  /** `media` for `/media/<id>` (WhatsApp, with a bearer), `cdn` for `/cdn/<name>`. */
  readonly kind: 'media' | 'cdn';
  readonly name: string;
  /** The `Authorization` header, which a CDN fetch must not carry. */
  readonly authorization: string | null;
}

const SIXTY_DAYS_SECONDS = 60 * 24 * 60 * 60;
const MEDIA_BEARER = /^Bearer (\S+)$/;

const reply = (status: number, body: unknown): Answer => ({ status, body });

const graphFailure = (
  status: number,
  code: number,
  message: string,
  extra: Record<string, unknown> = {},
): Answer =>
  reply(status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'FAKE', ...extra } });

/** Graph's answer to an id that is not there, is not the token's, or has no such edge. */
const unknownObject = (id: string, method = 'GET'): Answer =>
  graphFailure(
    400,
    100,
    `Unsupported ${method.toLowerCase()} request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`,
    { error_subcode: 33 },
  );

const invalidToken = (): Answer =>
  graphFailure(401, 190, 'Invalid OAuth access token - Cannot parse access token');

const toRoot = (platform: MetaPlatform): FakeGraphRoot =>
  platform === 'instagram' ? 'instagram' : 'facebook';

/** A number without its `+`, so `+1 650…` and `1650…` are one customer. */
const customerKey = (recipient: string): string => recipient.replace(/^\+/, '');

interface ParsedSend {
  readonly payload: WhatsAppSendPayload | MessagingSendPayload;
  readonly recipient: string;
  /** The body as sent, for the record. */
  readonly json: unknown;
}

/** The body of a send against the contract in `send-payloads.ts`, or Graph's refusal of it. */
const parseSend = (platform: MetaPlatform, raw: Buffer): ParsedSend | Answer => {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return graphFailure(400, 100, 'The request body is not JSON');
  }
  const parsed =
    platform === 'whatsapp'
      ? whatsappSendPayloadSchema.safeParse(json)
      : messagingSendPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return graphFailure(400, 100, 'Invalid parameter', {
      error_data: {
        details: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      },
    });
  }
  const payload = parsed.data;

  return {
    payload,
    json,
    recipient:
      'message' in payload ? payload.recipient.id : (payload.to ?? payload.recipient ?? ''),
  };
};

/**
 * What Meta documents a text may be, written here again on purpose and not
 * imported from `@helpdock/schemas`, for the reason `REPLY_WINDOW_MS` gives:
 * WhatsApp 4,096 characters, Messenger 2,000 characters, Instagram 1,000 bytes.
 */
const TEXT_LIMITS: Readonly<
  Record<MetaPlatform, { readonly max: number; readonly unit: 'characters' | 'bytes' }>
> = {
  whatsapp: { max: 4_096, unit: 'characters' },
  messenger: { max: 2_000, unit: 'characters' },
  instagram: { max: 1_000, unit: 'bytes' },
};

/** Graph's refusal of a text over the platform's limit, or null when it fits. */
const textOverLimit = (platform: MetaPlatform, text: string | null): Answer | null => {
  const limit = TEXT_LIMITS[platform];
  if (text === null) {
    return null;
  }
  const size = limit.unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : text.length;

  return size <= limit.max
    ? null
    : graphFailure(400, 100, 'Invalid parameter', {
        error_data: {
          details: `Message text is ${String(size)} ${limit.unit}, over the limit of ${String(limit.max)}`,
        },
      });
};

/**
 * Meta's own windows, written here again on purpose and not imported from
 * `@helpdock/schemas`: the stand-in is the independent check on what Helpdock
 * believes, so a wrong constant in Helpdock fails a suite instead of agreeing
 * with itself. A free-form reply is taken for 24 hours after the customer's last
 * message; the `HUMAN_AGENT` tag, on Messenger and Instagram only, for seven days.
 */
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** The ids the stand-in gives what it accepts start here, beyond the ones a suite gives a customer's messages. */
const SENT_ID_BASE = 5_000_000;
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface FakeGraphOptions {
  /** The app the stand-in reports as subscribed. */
  readonly appId?: string;
  readonly appName?: string;
  /** The clock token expiry is judged by. */
  readonly now?: () => Date;
}

export class FakeGraph {
  readonly calls: GraphCall[] = [];
  /** Messages the stand-in accepted, in order. */
  readonly sent: FakeSentMessage[] = [];
  /** Files uploaded with `POST /{id}/media`, by the media id answered. */
  readonly uploads = new Map<string, FakeUpload>();
  /** WhatsApp media the stand-in serves for `GET /{media-id}`, by media id. */
  readonly media = new Map<string, { readonly bytes: Buffer; readonly mimeType: string }>();
  /** Attachment bytes `GET /cdn/<name>` serves, with no token. */
  readonly cdn = new Map<string, { readonly bytes: Buffer; readonly contentType: string }>();
  /** `GET /{psid}?fields=` answers: first_name and last_name, or name and username. */
  readonly profiles = new Map<string, Record<string, string>>();
  /** Customers a send is refused for with the closed-window error of their platform. */
  readonly windowClosed = new Set<string>();
  /**
   * When each customer last wrote, by the id Helpdock sends to, as Meta would
   * know it. A customer listed here is judged by the windows of a real platform:
   * a free-form reply after 24 hours, or a `HUMAN_AGENT` one after seven days,
   * is refused with the closed-window error. A customer not listed is not judged
   * (a test that does not care about the window need not say when they wrote),
   * except that the tag is never taken for one who has not written.
   */
  readonly lastCustomerMessage = new Map<string, Date>();
  /** Customers a send is refused for with the pair rate limit (`131056`). */
  readonly pairLimited = new Set<string>();
  /** Customers a send is refused for with `551`, as for a person who blocked the Page. */
  readonly blocked = new Set<string>();
  /** Tokens every call is refused for with `190`, as for a token that expired. */
  readonly expiredTokens = new Set<string>();
  /** Media ids and CDN names that answer 404, as after Meta dropped them. */
  readonly expiredMedia = new Set<string>();
  /** Ids whose profile read is refused, as for a Page without the reviewed feature. */
  readonly profileDenied = new Set<string>();
  /** WhatsApp templates by business account id, for `GET /{waba}/message_templates` (M10-09). */
  readonly templates = new Map<string, unknown[]>();
  /** Refusals queued for the next matching requests, oldest first. */
  readonly failures: FakeFailure[] = [];
  /** Requests for media bytes, which are not Graph calls and so are not in `calls`. */
  readonly mediaRequests: FakeMediaRequest[] = [];
  /** Every Instagram token refresh answers 400 while this is true. */
  refuseRefresh = false;
  /** `http://127.0.0.1:<port>`. */
  url = '';

  readonly #accounts = new Map<string, FakeGraphAccount>();
  /** WhatsApp business account id → the ids of the numbers connected under it. */
  readonly #wabas = new Map<string, Set<string>>();
  readonly #tokens = new Map<string, TokenFacts>();
  readonly #subscriptions = new Map<string, FakeSubscription[]>();
  readonly #appId: string;
  readonly #appName: string;
  readonly #now: () => Date;
  #server: Server | undefined;
  #counter = 0;

  constructor({
    appId = '1234567890123456',
    appName = 'Helpdock',
    now = () => new Date(),
  }: FakeGraphOptions = {}) {
    this.#appId = appId;
    this.#appName = appName;
    this.#now = now;
  }

  /** What `META_GRAPH_API_ROOT` should be: WhatsApp and Messenger calls. */
  get facebookRoot(): string {
    return `${this.url}/facebook`;
  }

  /** What `META_INSTAGRAM_API_ROOT` should be: Instagram calls. */
  get instagramRoot(): string {
    return `${this.url}/instagram`;
  }

  async start(port = 0): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request).then(
        ({ status, body, raw, contentType, headers }) => {
          response.statusCode = status;
          for (const [name, value] of Object.entries(headers ?? {})) {
            response.setHeader(name, value);
          }
          if (raw !== undefined) {
            response.setHeader('content-type', contentType ?? 'application/octet-stream');
            response.end(raw);
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end(body === undefined ? '' : JSON.stringify(body));
        },
        () => {
          response.statusCode = 500;
          response.end();
        },
      );
    });
    await new Promise<void>((resolve) => this.#server?.listen(port, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server?.close(resolve));
  }

  /** Forgets the calls and everything a test programmed, and keeps the accounts. */
  reset(): void {
    this.calls.length = 0;
    this.mediaRequests.length = 0;
    this.sent.length = 0;
    this.uploads.clear();
    this.windowClosed.clear();
    this.lastCustomerMessage.clear();
    this.pairLimited.clear();
    this.blocked.clear();
    this.expiredTokens.clear();
    this.expiredMedia.clear();
    this.profileDenied.clear();
    this.failures.length = 0;
    this.refuseRefresh = false;
  }

  /**
   * Makes an account and a token that opens it. A system-user token can open
   * several WhatsApp numbers: connect the second with the same `token`. A
   * WhatsApp number needs its `wabaId`, and the token opens the business account
   * as well as the number, as a system user's does.
   */
  connect(
    account: FakeGraphAccount & {
      readonly token: string;
      /** When the token expires; omitted for one that never does. */
      readonly expiresAt?: Date;
    },
  ): void {
    const { token, expiresAt, ...identity } = account;
    if (identity.platform === 'whatsapp' && identity.wabaId === undefined) {
      throw new Error('A WhatsApp number belongs to a business account: pass its wabaId');
    }
    const root = toRoot(identity.platform);
    const known = this.#tokens.get(token);
    if (known !== undefined && known.root !== root) {
      throw new Error('One token is good on one root only');
    }
    this.#accounts.set(identity.id, identity);
    if (identity.wabaId !== undefined) {
      this.#wabas.set(
        identity.wabaId,
        new Set([...(this.#wabas.get(identity.wabaId) ?? []), identity.id]),
      );
    }
    this.#tokens.set(token, {
      ids: new Set([
        ...(known?.ids ?? []),
        identity.id,
        ...(identity.wabaId === undefined ? [] : [identity.wabaId]),
      ]),
      root,
      kind:
        identity.platform === 'whatsapp'
          ? 'SYSTEM_USER'
          : identity.platform === 'messenger'
            ? 'PAGE'
            : 'USER',
      expiresAt:
        expiresAt === undefined ? (known?.expiresAt ?? 0) : Math.floor(expiresAt.getTime() / 1_000),
    });
  }

  /**
   * Subscribes the app to the webhooks of a Page, an Instagram account or, for
   * WhatsApp, a business account (`wabaId`), as `POST /{id}/subscribed_apps`
   * does. The subscription of a business account covers every number under it.
   */
  subscribe(id: string, fields?: readonly string[]): void {
    const platform = this.#subscribable(id);
    this.#subscriptions.set(id, [
      {
        appId: this.#appId,
        name: this.#appName,
        fields: fields ?? META_SUBSCRIBED_FIELDS[platform],
      },
    ]);
  }

  /** Unsubscribes the app, as Meta does after an hour of failed deliveries. Takes `wabaId` for WhatsApp. */
  dropSubscription(id: string): void {
    this.#subscribable(id);
    this.#subscriptions.delete(id);
  }

  /** The fields the app is subscribed to; empty when it is not. Takes `wabaId` for WhatsApp. */
  subscriptionOf(id: string): readonly string[] {
    this.#subscribable(id);
    return this.#subscriptions.get(id)?.[0]?.fields ?? [];
  }

  /** The platform of an id that carries a subscription: a Page, an Instagram account or a business account. */
  #subscribable(id: string): MetaPlatform {
    if (this.#wabas.has(id)) {
      return 'whatsapp';
    }
    const account = this.#accounts.get(id);
    if (account === undefined) {
      throw new Error(`No account ${id}`);
    }
    if (account.platform === 'whatsapp') {
      throw new Error(
        `WhatsApp subscribes the business account, not the number: use ${account.wabaId ?? 'its wabaId'}, not ${id}`,
      );
    }

    return account.platform;
  }

  /** Whether a token is one the stand-in knows, refreshed ones included. */
  knowsToken(token: string): boolean {
    return this.#tokens.has(token);
  }

  /** Moves a token's expiry, in Unix seconds from the stand-in's clock; 0 for never. */
  setTokenExpiry(token: string, expiresAt: Date | null): void {
    const facts = this.#tokens.get(token);
    if (facts === undefined) {
      throw new Error('No such token');
    }
    facts.expiresAt = expiresAt === null ? 0 : Math.floor(expiresAt.getTime() / 1_000);
  }

  /** Serves WhatsApp media: the id a webhook names, and the bytes behind its short-lived URL. */
  serveMedia(id: string, bytes: Buffer, mimeType: string): string {
    this.media.set(id, { bytes, mimeType });
    return id;
  }

  /** Serves an attachment as a CDN would, and returns the URL a webhook payload carries. */
  serveCdn(name: string, bytes: Buffer, contentType: string): string {
    this.cdn.set(name, { bytes, contentType });
    return `${this.url}/cdn/${encodeURIComponent(name)}`;
  }

  /** The calls to `path` (a string suffix, or a pattern on `METHOD /path`), oldest first. */
  callsTo(path: string | RegExp, method?: string): GraphCall[] {
    return this.calls.filter(
      (call) =>
        (method === undefined || call.method === method) &&
        (typeof path === 'string'
          ? call.path.endsWith(path)
          : path.test(`${call.method} ${call.path}`)),
    );
  }

  /** The messages the stand-in accepted for one customer, oldest first. */
  sentTo(customerId: string): FakeSentMessage[] {
    const key = customerKey(customerId);
    return this.sent.filter((message) => customerKey(message.to) === key);
  }

  // ------------------------------------------------------------------------

  async #handle(request: IncomingMessage): Promise<Answer> {
    const url = new URL(request.url ?? '/', 'http://stand-in.test');
    const path = url.pathname;

    const cdn = /^\/cdn\/(.+)$/.exec(path);
    if (cdn !== null) {
      const name = decodeURIComponent(cdn[1] ?? '');
      this.mediaRequests.push({
        kind: 'cdn',
        name,
        authorization: request.headers.authorization ?? null,
      });
      const file = this.cdn.get(name);
      return file === undefined || this.expiredMedia.has(name)
        ? { status: 404, raw: Buffer.alloc(0) }
        : { status: 200, raw: file.bytes, contentType: file.contentType };
    }

    const media = /^\/media\/(.+)$/.exec(path);
    if (media !== null) {
      const name = decodeURIComponent(media[1] ?? '');
      this.mediaRequests.push({
        kind: 'media',
        name,
        authorization: request.headers.authorization ?? null,
      });
      return this.#serveMediaBytes(request, name);
    }

    const route = /^\/(facebook|instagram)\/(v\d+\.\d+)(\/.*)$/.exec(path);
    if (route === null) {
      return graphFailure(400, 100, 'Unknown path components');
    }
    const root = route[1] as FakeGraphRoot;
    const version = route[2] ?? '';
    const rest = route[3] ?? '';

    const query = Object.fromEntries(url.searchParams);
    const { body, recorded } = await readBody(request);
    const token = bearerOf(request) ?? query.access_token ?? null;
    this.calls.push({
      root,
      method: request.method ?? 'GET',
      path: rest,
      version,
      token,
      query,
      body: recorded,
    });

    const queued = this.failures.findIndex(
      (failure) => failure.match === undefined || failure.match.test(`${request.method} ${rest}`),
    );
    if (queued !== -1) {
      const [failure] = this.failures.splice(queued, 1);
      if (failure !== undefined) {
        return {
          status: failure.status,
          ...(failure.body === undefined ? {} : { body: failure.body }),
          ...(failure.headers === undefined ? {} : { headers: failure.headers }),
        };
      }
    }

    const facts = this.#authenticate(token, root);
    if ('status' in facts) {
      return facts;
    }

    return this.#route(request.method ?? 'GET', rest, {
      facts,
      token: token ?? '',
      query,
      body,
      recorded,
      root,
    });
  }

  /** The token's facts, or the refusal Graph gives for it. */
  #authenticate(token: string | null, root: FakeGraphRoot): TokenFacts | Answer {
    if (token === null) {
      return invalidToken();
    }
    if (this.expiredTokens.has(token)) {
      return reply(400, graphTokenExpired());
    }
    const facts = this.#tokens.get(token);
    if (facts === undefined || facts.root !== root) {
      return invalidToken();
    }
    if (facts.expiresAt !== 0 && facts.expiresAt * 1_000 <= this.#now().getTime()) {
      return reply(400, graphTokenExpired());
    }

    return facts;
  }

  #route(
    method: string,
    rest: string,
    context: {
      readonly facts: TokenFacts;
      readonly token: string;
      readonly query: Readonly<Record<string, string>>;
      readonly body: Buffer;
      readonly recorded: unknown;
      readonly root: FakeGraphRoot;
    },
  ): Answer {
    const segments = rest.split('/').filter((segment) => segment !== '');
    const [first, second] = segments;
    if (first === undefined) {
      return graphFailure(400, 100, 'Unknown path components');
    }

    if (segments.length === 1 && method === 'GET') {
      if (first === 'me') {
        const id = [...context.facts.ids][0] ?? '';
        return this.#identity(id, context.query.fields);
      }
      if (first === 'debug_token') {
        return this.#debugToken(context.query.input_token ?? '');
      }
      if (first === 'refresh_access_token') {
        return this.#refresh(context.token, context.facts, context.root);
      }
      return this.#read(first, context.facts, context.query.fields);
    }

    if (segments.length === 2 && second !== undefined) {
      const id = first === 'me' ? ([...context.facts.ids][0] ?? '') : first;
      if (second === 'messages' && method === 'POST') {
        return this.#send(id, context.facts, context.body);
      }
      if (second === 'media' && method === 'POST') {
        return this.#upload(id, context.facts, context.recorded);
      }
      if (second === 'subscribed_apps') {
        return this.#subscribedApps(method, id, context.facts, context.query);
      }
      if (second === 'phone_numbers' && method === 'GET') {
        return this.#phoneNumbers(id, context.facts);
      }
      if (second === 'message_templates' && method === 'GET') {
        return reply(200, { data: this.templates.get(id) ?? [], paging: {} });
      }
    }

    return graphFailure(400, 100, 'Unknown path components');
  }

  #owns(facts: TokenFacts, id: string): boolean {
    return facts.ids.has(id);
  }

  #identity(id: string, fields: string | undefined): Answer {
    const account = this.#accounts.get(id);
    if (account === undefined) {
      return unknownObject(id);
    }
    const all: Record<string, unknown> =
      account.platform === 'whatsapp'
        ? {
            id: account.id,
            display_phone_number: account.displayPhone ?? '',
            verified_name: account.name,
          }
        : account.platform === 'messenger'
          ? { id: account.id, name: account.name }
          : { id: account.id, username: account.username ?? '', name: account.name };
    if (fields === undefined || fields === '') {
      return reply(200, all);
    }
    const wanted = new Set(['id', ...fields.split(',').map((field) => field.trim())]);

    return reply(200, Object.fromEntries(Object.entries(all).filter(([key]) => wanted.has(key))));
  }

  /** `GET /{id}`: an account the token opens, a media id, or a customer's profile. */
  #read(id: string, facts: TokenFacts, fields: string | undefined): Answer {
    if (this.#accounts.has(id)) {
      return this.#owns(facts, id) ? this.#identity(id, fields) : unknownObject(id);
    }
    const media = this.media.get(id);
    if (media !== undefined) {
      if (this.expiredMedia.has(id)) {
        return graphFailure(404, 100, `Media ${id} has expired`, { error_subcode: 33 });
      }
      return reply(200, {
        messaging_product: 'whatsapp',
        url: `${this.url}/media/${encodeURIComponent(id)}`,
        mime_type: media.mimeType,
        sha256: sha256Hex(media.bytes),
        file_size: String(media.bytes.byteLength),
        id,
      });
    }
    const profile = this.profiles.get(id);
    if (profile !== undefined && !this.profileDenied.has(id)) {
      const wanted = fields === undefined ? null : new Set(fields.split(',').map((f) => f.trim()));
      return reply(200, {
        id,
        ...Object.fromEntries(
          Object.entries(profile).filter(([key]) => wanted === null || wanted.has(key)),
        ),
      });
    }
    if (this.profileDenied.has(id)) {
      return graphFailure(
        400,
        100,
        'Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation',
        { error_subcode: 33 },
      );
    }

    return unknownObject(id);
  }

  #serveMediaBytes(request: IncomingMessage, id: string): Answer {
    const bearer = MEDIA_BEARER.exec(request.headers.authorization ?? '')?.[1];
    // Meta serves the bytes to a bearer that opens some account, and to nobody else.
    if (bearer === undefined || !this.#tokens.has(bearer) || this.expiredTokens.has(bearer)) {
      return { status: 401, raw: Buffer.alloc(0) };
    }
    const file = this.media.get(id);

    return file === undefined || this.expiredMedia.has(id)
      ? { status: 404, raw: Buffer.alloc(0) }
      : { status: 200, raw: file.bytes, contentType: file.mimeType };
  }

  #send(id: string, facts: TokenFacts, raw: Buffer): Answer {
    const account = this.#accounts.get(id);
    if (account === undefined || !this.#owns(facts, id)) {
      return unknownObject(id);
    }
    const { platform } = account;
    const send = parseSend(platform, raw);
    if ('status' in send) {
      return send;
    }
    const tooLong = textOverLimit(platform, sendPayloadText(send.payload));
    if (tooLong !== null) {
      return tooLong;
    }
    const refused = this.#refusal(platform, send.recipient) ?? this.#outsideWindow(platform, send);
    if (refused !== null) {
      return refused;
    }

    this.#counter += 1;
    const messageId =
      platform === 'whatsapp'
        ? fixtureWamid(SENT_ID_BASE + this.#counter)
        : fixtureMid(SENT_ID_BASE + this.#counter);
    this.sent.push({
      accountId: id,
      platform,
      id: messageId,
      to: send.recipient,
      payload: send.json,
    });

    return reply(
      200,
      platform === 'whatsapp'
        ? {
            messaging_product: 'whatsapp',
            contacts: [{ input: send.recipient, wa_id: customerKey(send.recipient) }],
            messages: [{ id: messageId }],
          }
        : { recipient_id: send.recipient, message_id: messageId },
    );
  }

  /**
   * Graph's refusal of a send the customer's windows do not allow: free-form
   * text and files after 24 hours, the `HUMAN_AGENT` tag after seven days or for
   * a customer who never wrote. WhatsApp has no tag, so a body that carries one
   * never reaches here: it is an unknown parameter and `parseSend` refused it.
   */
  #outsideWindow(platform: MetaPlatform, { payload, recipient }: ParsedSend): Answer | null {
    const wrote =
      this.lastCustomerMessage.get(customerKey(recipient)) ??
      this.lastCustomerMessage.get(recipient);
    const age = wrote === undefined ? null : this.#now().getTime() - wrote.getTime();
    const tagged = 'message' in payload && payload.tag !== undefined;

    const allowed = tagged
      ? age !== null && age < HUMAN_AGENT_WINDOW_MS
      : age === null || age < REPLY_WINDOW_MS;

    return allowed ? null : reply(400, graphWindowClosed(platform));
  }

  /** The refusal a test programmed for this customer, if any: blocked, then window, then pair limit. */
  #refusal(platform: MetaPlatform, recipient: string): Answer | null {
    const key = customerKey(recipient);
    const programmed = (customers: ReadonlySet<string>): boolean =>
      customers.has(key) || customers.has(recipient);

    if (programmed(this.blocked)) {
      return reply(400, graphUserUnavailable());
    }
    if (programmed(this.windowClosed)) {
      return reply(400, graphWindowClosed(platform));
    }
    if (programmed(this.pairLimited)) {
      return reply(400, graphPairRateLimited());
    }

    return null;
  }

  #upload(id: string, facts: TokenFacts, recorded: unknown): Answer {
    const account = this.#accounts.get(id);
    if (account === undefined || !this.#owns(facts, id) || account.platform !== 'whatsapp') {
      return unknownObject(id);
    }
    const upload = (recorded as { readonly file?: FakeUpload | null } | null)?.file ?? null;
    if (upload === null) {
      return graphFailure(400, 100, 'Invalid parameter', {
        error_data: { details: 'A media upload carries a file' },
      });
    }
    this.#counter += 1;
    const mediaId = `FAKEMEDIA${String(this.#counter).padStart(6, '0')}`;
    this.uploads.set(mediaId, upload);

    return reply(200, { id: mediaId });
  }

  #subscribedApps(
    method: string,
    id: string,
    facts: TokenFacts,
    query: Readonly<Record<string, string>>,
  ): Answer {
    const platform = this.#wabas.has(id) ? 'whatsapp' : this.#accounts.get(id)?.platform;
    if (platform === undefined || !this.#owns(facts, id)) {
      return unknownObject(id, method);
    }
    // The edge is on the business account. A number's own id has none, which
    // is what Graph answers there and how a caller using it finds out.
    if (this.#accounts.get(id)?.platform === 'whatsapp') {
      return unknownObject(id, method);
    }
    if (method === 'GET') {
      const apps = this.#subscriptions.get(id) ?? [];
      return reply(200, {
        data: apps.map((app) =>
          graphSubscribedApp(platform, {
            appId: app.appId,
            name: app.name,
            fields: app.fields,
          }),
        ),
      });
    }
    if (method === 'POST') {
      const requested = query.subscribed_fields?.split(',').map((field) => field.trim());
      this.subscribe(id, requested === undefined || requested.length === 0 ? undefined : requested);
      return reply(200, { success: true });
    }
    if (method === 'DELETE') {
      this.dropSubscription(id);
      return reply(200, { success: true });
    }

    return graphFailure(400, 100, 'Unknown path components');
  }

  /** `GET /{waba}/phone_numbers`: the numbers connected under a business account. */
  #phoneNumbers(id: string, facts: TokenFacts): Answer {
    const numbers = this.#wabas.get(id);
    if (numbers === undefined || !this.#owns(facts, id)) {
      return unknownObject(id);
    }

    return reply(200, {
      data: [...numbers].flatMap((numberId) => {
        const account = this.#accounts.get(numberId);
        return account === undefined
          ? []
          : [
              {
                id: account.id,
                display_phone_number: account.displayPhone ?? '',
                verified_name: account.name,
                ...(account.qualityRating === undefined
                  ? {}
                  : { quality_rating: account.qualityRating }),
              },
            ];
      }),
    });
  }

  /** The business accounts a WhatsApp token opens, which is how a number is traced to its own. */
  #granularScopes(facts: TokenFacts): unknown[] {
    const targets = [...facts.ids].filter((id) => this.#wabas.has(id));

    return ['whatsapp_business_management', 'whatsapp_business_messaging'].map((scope) => ({
      scope,
      target_ids: targets,
    }));
  }

  #debugToken(input: string): Answer {
    const facts = this.#tokens.get(input);
    if (this.expiredTokens.has(input) || facts === undefined) {
      return reply(200, {
        data: {
          app_id: this.#appId,
          is_valid: false,
          scopes: [],
          error: {
            code: 190,
            message: facts === undefined ? 'Invalid OAuth access token.' : 'Session has expired',
            subcode: facts === undefined ? 467 : 463,
          },
        },
      });
    }
    const expired = facts.expiresAt !== 0 && facts.expiresAt * 1_000 <= this.#now().getTime();

    return reply(200, {
      data: {
        app_id: this.#appId,
        type: facts.kind,
        application: this.#appName,
        expires_at: facts.expiresAt,
        is_valid: !expired,
        scopes: [
          'whatsapp_business_messaging',
          'pages_messaging',
          'instagram_business_manage_messages',
        ],
        ...(facts.kind === 'SYSTEM_USER' ? { granular_scopes: this.#granularScopes(facts) } : {}),
      },
    });
  }

  #refresh(token: string, facts: TokenFacts, root: FakeGraphRoot): Answer {
    if (root !== 'instagram') {
      return graphFailure(400, 100, 'Unknown path components');
    }
    if (this.refuseRefresh) {
      return graphFailure(400, 100, 'Invalid parameter', {
        error_data: { details: 'The token cannot be refreshed' },
      });
    }
    this.#counter += 1;
    const renewed = `${token}.r${String(this.#counter)}`;
    this.#tokens.set(renewed, {
      ids: facts.ids,
      root: facts.root,
      kind: facts.kind,
      expiresAt: Math.floor(this.#now().getTime() / 1_000) + SIXTY_DAYS_SECONDS,
    });

    // A new token string, with the old one left working: Helpdock must store
    // what it is given, and a test can see whether it did.
    return reply(200, {
      access_token: renewed,
      token_type: 'bearer',
      expires_in: SIXTY_DAYS_SECONDS,
    });
  }
}

const bearerOf = (request: IncomingMessage): string | null =>
  MEDIA_BEARER.exec(request.headers.authorization ?? '')?.[1] ?? null;

/**
 * The request body, and what to record of it: parsed JSON, or for a multipart
 * upload the text fields and the file.
 */
const readBody = async (
  request: IncomingMessage,
): Promise<{ readonly body: Buffer; readonly recorded: unknown }> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const type = request.headers['content-type'] ?? '';
  if (body.length === 0) {
    return { body, recorded: null };
  }
  if (type.startsWith('multipart/form-data')) {
    const form = await new Response(body, { headers: { 'content-type': type } }).formData();
    const fields: Record<string, string> = {};
    let file: FakeUpload | null = null;
    for (const [key, value] of form) {
      if (typeof value === 'string') {
        fields[key] = value;
      } else {
        file = {
          name: value.name,
          contentType: value.type,
          bytes: Buffer.from(await value.arrayBuffer()),
        };
      }
    }
    return { body, recorded: { fields, file } };
  }
  try {
    return { body, recorded: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { body, recorded: body.toString('utf8') };
  }
};

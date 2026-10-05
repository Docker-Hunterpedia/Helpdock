import {
  API_KEY_PREFIX,
  API_KEY_RATE_LIMIT_DEFAULT,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeyCreateRequest,
  type ApiKeyList,
  WEBHOOK_EVENTS,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_TEST_EVENT,
  type Webhook,
  type WebhookCreateRequest,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookDeliveryEvent,
  type WebhookDeliveryList,
  type WebhookOverview,
  type WebhookOverviewList,
  type WebhookUpdateRequest,
  type WebhookWithSecret,
} from '@helpdock/schemas';
import { type DevelopersApi, WebhooksError } from './api.js';

/**
 * The Developers fixture: the keys and endpoints of `Admin/Developers-ApiKeys`
 * and `Admin/Developers-Webhooks`, for whichever brand asks. What it refuses
 * mirrors the api closely enough for the form's error lines to be exercised —
 * plain http, and a name that "resolves" to a private address — while the real
 * rules are `webhook-destination.ts`'s and are tested there.
 *
 * A test ping is answered `pending` on the first read and delivered on the
 * next, so the screen's wait for it runs as it does against the api.
 */

const PAGE_SIZE = 50;
const ME = 'Lina Haddad';
const PRIVATE_NAME = /(^|\.)(internal|local|localhost|lan|corp)(\.|$)/;

let sequence = 0;
const nextId = (): string => {
  sequence += 1;
  return `0192d4e0-2b3c-7d4e-8f50-${sequence.toString(16).padStart(12, '0')}`;
};

const randomTail = (length: number): string =>
  Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');

interface StoredDelivery {
  readonly delivery: WebhookDelivery;
  readonly payload: Record<string, unknown>;
  /** Reads left before a queued delivery shows its outcome. */
  pendingReads: number;
}

interface StoredWebhook {
  webhook: Webhook;
  readonly createdByName: string | null;
  readonly deliveries: StoredDelivery[];
}

interface BrandFixture {
  readonly keys: ApiKey[];
  readonly webhooks: StoredWebhook[];
}

const apiKey = (
  name: string,
  tail: string,
  scopes: ApiKey['scopes'],
  rateLimitPerMinute: number,
  createdByName: string,
  createdAt: string,
  lastUsedAt: string | null,
  revoked: { at: string; by: string } | null = null,
): ApiKey => ({
  id: nextId(),
  name,
  prefix: `${API_KEY_PREFIX}${tail}`,
  scopes,
  rateLimitPerMinute,
  createdAt,
  lastUsedAt,
  revokedAt: revoked?.at ?? null,
  createdByName,
  revokedByName: revoked?.by ?? null,
});

const webhookRow = (url: string, events: Webhook['events'], createdAt: string): Webhook => ({
  id: nextId(),
  url,
  description: '',
  events,
  enabled: true,
  disabledReason: null,
  consecutiveFailures: 0,
  secretRotatedAt: null,
  createdAt,
  updatedAt: createdAt,
});

const deliveryOf = (
  webhookId: string,
  event: WebhookDeliveryEvent,
  createdAt: string,
  outcome: Partial<WebhookDelivery>,
): WebhookDelivery => ({
  id: nextId(),
  webhookId,
  eventId: nextId(),
  event,
  status: 'succeeded',
  attempts: 1,
  responseStatus: 200,
  responseExcerpt: 'ok',
  durationMs: 120,
  error: null,
  replayOf: null,
  createdAt,
  lastAttemptAt: createdAt,
  deliveredAt: createdAt,
  ...outcome,
});

const ticketPayload = (number: number, subject: string) => ({
  ticket: { number, subject, status: 'open', channel: 'email' },
});

const fixture = (now: number): BrandFixture => {
  const minutesAgo = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
  const daysAgo = (days: number): string => minutesAgo(days * 24 * 60);

  const acme = webhookRow(
    'https://ops.acme-shop.com/hooks/helpdock',
    ['ticket.created', 'ticket.replied', 'ticket.updated', 'ticket.closed'],
    daysAgo(21),
  );
  const zapier = webhookRow(
    'https://hooks.zapier.com/hooks/catch/18392/abx',
    [...WEBHOOK_EVENTS],
    daysAgo(30),
  );
  const n8n = webhookRow('https://n8n.helpdock.io/webhook/csat', ['csat.received'], daysAgo(12));
  const legacy: Webhook = {
    ...webhookRow('https://hooks.legacy-crm.example/helpdock', ['contact.created'], daysAgo(60)),
    enabled: false,
    disabledReason: 'failures',
    consecutiveFailures: 10,
  };

  const stored = (delivery: WebhookDelivery, data: Record<string, unknown>): StoredDelivery => ({
    delivery,
    payload: { id: delivery.eventId, event: delivery.event, createdAt: delivery.createdAt, data },
    pendingReads: 0,
  });

  const acmeLog = [
    stored(
      deliveryOf(acme.id, 'ticket.replied', minutesAgo(9), {
        status: 'pending',
        attempts: 3,
        responseStatus: 500,
        responseExcerpt: '{"error":"upstream timeout","request_id":"a91f-22c0"}',
        durationMs: 2100,
        error: 'The endpoint answered 500',
        lastAttemptAt: minutesAgo(1),
        deliveredAt: null,
      }),
      { ...ticketPayload(1042, 'Order 10442 arrived damaged'), message: { public: true } },
    ),
    stored(
      deliveryOf(acme.id, 'ticket.created', minutesAgo(10), { durationMs: 184 }),
      ticketPayload(1047, 'Refund for a double charge'),
    ),
    stored(
      deliveryOf(acme.id, 'ticket.updated', minutesAgo(15), {
        status: 'pending',
        attempts: 2,
        responseStatus: null,
        responseExcerpt: null,
        durationMs: 15_000,
        error: 'timeout: no answer within 15000 ms',
        lastAttemptAt: minutesAgo(0.5),
        deliveredAt: null,
      }),
      ticketPayload(1039, 'Cannot sign in'),
    ),
    stored(
      deliveryOf(acme.id, 'contact.created', minutesAgo(20), {
        status: 'pending',
        responseStatus: null,
        responseExcerpt: null,
        durationMs: 212,
        error: 'The endpoint answered with a redirect; redirects are not followed',
        lastAttemptAt: minutesAgo(0.1),
        deliveredAt: null,
      }),
      { contact: { name: 'Mona Khalil' } },
    ),
    stored(
      deliveryOf(acme.id, 'ticket.closed', minutesAgo(27), { durationMs: 96 }),
      ticketPayload(1031, 'Invoice address'),
    ),
    stored(
      deliveryOf(acme.id, 'ticket.created', minutesAgo(31), { attempts: 2, durationMs: 143 }),
      ticketPayload(1046, 'Shipping to Riyadh'),
    ),
  ];
  const n8nLog = [
    stored(
      deliveryOf(n8n.id, 'csat.received', minutesAgo(5), {
        status: 'pending',
        responseStatus: null,
        responseExcerpt: null,
        durationMs: 3,
        error: 'destination-blocked: n8n.helpdock.io resolves to 127.0.0.1, a loopback address',
        lastAttemptAt: minutesAgo(0.1),
        deliveredAt: null,
      }),
      { survey: { rating: 5 } },
    ),
    stored(
      deliveryOf(n8n.id, 'csat.received', minutesAgo(64), {
        status: 'failed',
        attempts: 8,
        responseStatus: 504,
        responseExcerpt: 'Gateway Time-out',
        durationMs: 15_000,
        error: 'The endpoint answered 504',
        deliveredAt: null,
      }),
      { survey: { rating: 2 } },
    ),
  ];
  const legacyLog = [
    stored(
      deliveryOf(legacy.id, 'contact.created', daysAgo(3), {
        status: 'failed',
        attempts: 8,
        responseStatus: 503,
        responseExcerpt: 'Service Unavailable',
        durationMs: 88,
        error: 'The endpoint answered 503',
        deliveredAt: null,
      }),
      { contact: { name: 'Omar Saleh' } },
    ),
  ];
  const zapierLog = [
    stored(
      deliveryOf(zapier.id, 'ticket.replied', minutesAgo(4), { durationMs: 310 }),
      ticketPayload(1048, 'Where is my parcel?'),
    ),
  ];

  return {
    keys: [
      apiKey(
        'Zapier sync',
        'ab12',
        ['tickets:read', 'tickets:write', 'contacts:write'],
        600,
        ME,
        daysAgo(23),
        minutesAgo(2),
      ),
      apiKey(
        'Shop backend',
        '7f3c',
        ['contacts:read', 'contacts:write', 'tickets:write'],
        1200,
        'Omar',
        daysAgo(1),
        minutesAgo(0.25),
      ),
      apiKey('Status page', 'c91e', ['articles:read'], 120, 'Karim', daysAgo(7), minutesAgo(180)),
      apiKey(
        'Data warehouse',
        'e04d',
        ['tickets:read', 'contacts:read'],
        300,
        ME,
        daysAgo(15),
        null,
      ),
      apiKey(
        'CI webhook setup',
        '5b8a',
        ['webhooks:manage'],
        60,
        'Sara',
        daysAgo(4),
        minutesAgo(18 * 60),
      ),
      apiKey('Old CRM import', '0a77', ['contacts:write'], 600, 'Omar', daysAgo(64), daysAgo(6), {
        at: daysAgo(5),
        by: ME,
      }),
    ],
    webhooks: [
      { webhook: acme, createdByName: 'Omar', deliveries: acmeLog },
      { webhook: zapier, createdByName: ME, deliveries: zapierLog },
      { webhook: n8n, createdByName: 'Karim', deliveries: n8nLog },
      { webhook: legacy, createdByName: 'Omar', deliveries: legacyLog },
    ],
  };
};

const refusalFor = (raw: string): WebhooksError | undefined => {
  const url = URL.parse(raw);
  if (url === null) {
    return undefined;
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return new WebhooksError('webhook-destination-blocked', '127.0.0.1');
  }
  if (PRIVATE_NAME.test(url.hostname) || /^10\./.test(url.hostname)) {
    return new WebhooksError('webhook-destination-blocked', '10.0.4.12');
  }
  return url.protocol === 'http:' ? new WebhooksError('webhook-https-required') : undefined;
};

export class MockDevelopersApi implements DevelopersApi {
  readonly #byBrand = new Map<string, BrandFixture>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  apiKeys(brandId: string): Promise<ApiKeyList> {
    return Promise.resolve({ keys: [...this.#brand(brandId).keys] });
  }

  createApiKey(brandId: string, request: ApiKeyCreateRequest): Promise<ApiKeyCreated> {
    const key = `${API_KEY_PREFIX}${randomTail(43)}`;
    const created: ApiKey = {
      id: nextId(),
      name: request.name.trim(),
      prefix: key.slice(0, API_KEY_PREFIX.length + 4),
      scopes: [...request.scopes],
      rateLimitPerMinute: request.rateLimitPerMinute ?? API_KEY_RATE_LIMIT_DEFAULT,
      createdAt: this.#iso(),
      lastUsedAt: null,
      revokedAt: null,
      createdByName: ME,
      revokedByName: null,
    };
    this.#brand(brandId).keys.unshift(created);
    return Promise.resolve({ ...created, key });
  }

  revokeApiKey(brandId: string, keyId: string): Promise<ApiKey> {
    const keys = this.#brand(brandId).keys;
    const index = keys.findIndex((key) => key.id === keyId);
    const existing = keys[index];
    if (existing === undefined) {
      return Promise.reject(new Error('No such API key'));
    }
    const revoked =
      existing.revokedAt === null
        ? { ...existing, revokedAt: this.#iso(), revokedByName: ME }
        : existing;
    keys[index] = revoked;
    return Promise.resolve(revoked);
  }

  webhooks(brandId: string): Promise<WebhookOverviewList> {
    const since = this.#now() - 24 * 60 * 60_000;
    return Promise.resolve({
      webhooks: this.#brand(brandId).webhooks.map((stored): WebhookOverview => {
        const views = stored.deliveries.map((entry) => this.#view(entry, false));
        const recent = views.filter(
          (delivery) =>
            Date.parse(delivery.createdAt) >= since &&
            (delivery.status === 'succeeded' || delivery.status === 'failed'),
        );
        return {
          ...stored.webhook,
          createdByName: stored.createdByName,
          last24h: {
            total: recent.length,
            succeeded: recent.filter((delivery) => delivery.status === 'succeeded').length,
          },
          lastDelivery: views[0] ?? null,
        };
      }),
    });
  }

  createWebhook(brandId: string, request: WebhookCreateRequest): Promise<WebhookWithSecret> {
    const refusal = refusalFor(request.url);
    if (refusal !== undefined) {
      return Promise.reject(refusal);
    }
    const webhook = webhookRow(request.url, [...request.events], this.#iso());
    this.#brand(brandId).webhooks.unshift({ webhook, createdByName: ME, deliveries: [] });
    return Promise.resolve({ ...webhook, secret: this.#secret() });
  }

  updateWebhook(
    brandId: string,
    webhookId: string,
    request: WebhookUpdateRequest,
  ): Promise<Webhook> {
    const refusal = request.url === undefined ? undefined : refusalFor(request.url);
    if (refusal !== undefined) {
      return Promise.reject(refusal);
    }
    return this.#change(brandId, webhookId, (webhook) => ({
      ...webhook,
      ...(request.url === undefined ? {} : { url: request.url }),
      ...(request.events === undefined ? {} : { events: [...request.events] }),
      ...(request.enabled === undefined
        ? {}
        : request.enabled
          ? { enabled: true, disabledReason: null, consecutiveFailures: 0 }
          : { enabled: false, disabledReason: null }),
      updatedAt: this.#iso(),
    }));
  }

  removeWebhook(brandId: string, webhookId: string): Promise<void> {
    const webhooks = this.#brand(brandId).webhooks;
    const index = webhooks.findIndex((stored) => stored.webhook.id === webhookId);
    if (index === -1) {
      return Promise.reject(new Error('No such webhook'));
    }
    webhooks.splice(index, 1);
    return Promise.resolve();
  }

  async rotateWebhookSecret(brandId: string, webhookId: string): Promise<WebhookWithSecret> {
    const webhook = await this.#change(brandId, webhookId, (row) => ({
      ...row,
      secretRotatedAt: this.#iso(),
    }));
    return { ...webhook, secret: this.#secret() };
  }

  sendTestEvent(brandId: string, webhookId: string): Promise<WebhookDelivery> {
    return this.#queue(brandId, webhookId, WEBHOOK_TEST_EVENT, null, {
      webhook: { id: webhookId },
    });
  }

  deliveries(brandId: string, webhookId: string, cursor?: string): Promise<WebhookDeliveryList> {
    const stored = this.#stored(brandId, webhookId);
    if (stored === undefined) {
      return Promise.reject(new Error('No such webhook'));
    }
    const start =
      cursor === undefined
        ? 0
        : stored.deliveries.findIndex((entry) => entry.delivery.id === cursor) + 1;
    const page = stored.deliveries.slice(start, start + PAGE_SIZE);
    return Promise.resolve({
      deliveries: page.map((entry) => this.#view(entry, true)),
      nextCursor:
        start + PAGE_SIZE < stored.deliveries.length ? (page.at(-1)?.delivery.id ?? null) : null,
    });
  }

  delivery(brandId: string, webhookId: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
    const stored = this.#stored(brandId, webhookId);
    const entry = stored?.deliveries.find((candidate) => candidate.delivery.id === deliveryId);
    if (stored === undefined || entry === undefined) {
      return Promise.reject(new Error('No such delivery'));
    }
    const delivery = this.#view(entry, true);
    const attempted = delivery.lastAttemptAt;
    const headers =
      attempted === null
        ? []
        : [
            { name: 'content-type', value: 'application/json' },
            { name: 'user-agent', value: 'Helpdock-Webhooks/1' },
            { name: 'x-helpdock-event', value: delivery.event },
            { name: 'x-helpdock-event-id', value: delivery.eventId },
            { name: 'x-helpdock-delivery', value: delivery.id },
            {
              name: 'x-helpdock-signature',
              value: `t=${String(Math.floor(Date.parse(attempted) / 1000))},v1=5d2f8a19c0e7${'0'.repeat(44)}4b77c41e`,
            },
          ];
    return Promise.resolve({
      ...delivery,
      request: {
        method: 'POST',
        url: stored.webhook.url,
        headers,
        body: JSON.stringify(entry.payload),
      },
    });
  }

  replayDelivery(brandId: string, webhookId: string, deliveryId: string): Promise<WebhookDelivery> {
    const original = this.#stored(brandId, webhookId)?.deliveries.find(
      (entry) => entry.delivery.id === deliveryId,
    );
    if (original === undefined) {
      return Promise.reject(new Error('No such delivery'));
    }
    return this.#queue(
      brandId,
      webhookId,
      original.delivery.event,
      original.delivery.id,
      original.payload,
    );
  }

  #queue(
    brandId: string,
    webhookId: string,
    event: WebhookDeliveryEvent,
    replayOf: string | null,
    data: Record<string, unknown>,
  ): Promise<WebhookDelivery> {
    const stored = this.#stored(brandId, webhookId);
    if (stored === undefined) {
      return Promise.reject(new Error('No such webhook'));
    }
    const delivery = deliveryOf(webhookId, event, this.#iso(), {
      durationMs: 162,
      replayOf,
    });
    const entry: StoredDelivery = {
      delivery,
      payload: { id: delivery.eventId, event, createdAt: delivery.createdAt, data },
      pendingReads: 1,
    };
    stored.deliveries.unshift(entry);
    return Promise.resolve(this.#view(entry, false));
  }

  /** A queued delivery reads as pending until it has been read `pendingReads` times. */
  #view(entry: StoredDelivery, read: boolean): WebhookDelivery {
    if (entry.pendingReads === 0) {
      return entry.delivery;
    }
    if (read) {
      entry.pendingReads -= 1;
    }
    return {
      ...entry.delivery,
      status: 'pending',
      attempts: 0,
      responseStatus: null,
      responseExcerpt: null,
      durationMs: null,
      lastAttemptAt: null,
      deliveredAt: null,
    };
  }

  #brand(brandId: string): BrandFixture {
    let brand = this.#byBrand.get(brandId);
    if (brand === undefined) {
      brand = fixture(this.#now());
      this.#byBrand.set(brandId, brand);
    }
    return brand;
  }

  #stored(brandId: string, webhookId: string): StoredWebhook | undefined {
    return this.#brand(brandId).webhooks.find((stored) => stored.webhook.id === webhookId);
  }

  #change(
    brandId: string,
    webhookId: string,
    change: (webhook: Webhook) => Webhook,
  ): Promise<Webhook> {
    const stored = this.#stored(brandId, webhookId);
    if (stored === undefined) {
      return Promise.reject(new Error('No such webhook'));
    }
    stored.webhook = change(stored.webhook);
    return Promise.resolve(stored.webhook);
  }

  #secret(): string {
    return `${WEBHOOK_SECRET_PREFIX}${randomTail(43)}`;
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}

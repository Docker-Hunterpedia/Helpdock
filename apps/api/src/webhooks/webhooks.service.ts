import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, type Keyring } from '@helpdock/config';
import { auditLog, type WebhookDeliveryRow, type WebhookRow } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import {
  WEBHOOK_DELIVERY_PAGE_SIZE,
  WEBHOOK_TEST_EVENT,
  type Webhook,
  type WebhookCreateRequest,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookDeliveryList,
  type WebhookDeliveryQuery,
  type WebhookList,
  type WebhookOverviewList,
  type WebhookUpdateRequest,
  type WebhookWithSecret,
  webhookDeliveryEventSchema,
  webhookEventSchema,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { BrandActor } from '../context/brand-actor.js';
import type { WebhookDestinationCheck } from './webhook-destination.js';
import { WEBHOOK_DELIVERY_REQUESTED_EVENT } from './webhook-events.js';
import { webhookRequest, webhookRequestBody } from './webhook-request.js';
import { issueWebhookSecret } from './webhook-signature.js';
import type { WebhooksRepository } from './webhooks.repository.js';

/** The window of the Developers page's success rate. */
const OVERVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * M8-02 and M8-03: a brand's webhook endpoints and their delivery log, for the
 * Admin's settings and for the public API's `webhooks:manage` scope alike.
 *
 * The signing secret is generated here, encrypted under `APP_MASTER_KEY`, and
 * returned once — on create and on rotation — and never again. Every change is
 * written to `audit_log` in the same transaction, naming the staff member or
 * the API key that made it; the secret is never in the row.
 */

const knownEvents = (events: readonly string[]) =>
  events.flatMap((event) => {
    const parsed = webhookEventSchema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });

export const toWebhook = (row: WebhookRow): Webhook => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: knownEvents(row.events),
  enabled: row.enabled,
  disabledReason: row.disabledReason === 'failures' ? 'failures' : null,
  consecutiveFailures: row.consecutiveFailures,
  secretRotatedAt: row.secretRotatedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toWebhookDelivery = (row: WebhookDeliveryRow): WebhookDelivery => ({
  id: row.id,
  webhookId: row.webhookId,
  eventId: row.eventId,
  event: webhookDeliveryEventSchema.parse(row.event),
  status: row.status,
  attempts: row.attempts,
  responseStatus: row.responseStatus,
  responseExcerpt: row.responseExcerpt,
  durationMs: row.durationMs,
  error: row.error,
  replayOf: row.replayOf,
  createdAt: row.createdAt.toISOString(),
  lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
  deliveredAt: row.deliveredAt?.toISOString() ?? null,
});

type WebhookAuditAction =
  | 'webhook.created'
  | 'webhook.updated'
  | 'webhook.deleted'
  | 'webhook.secret_rotated'
  | 'webhook.delivery_replayed'
  | 'webhook.tested';

export interface WebhooksServiceOptions {
  /** Where an endpoint's name resolves, checked when it is added or changed. */
  readonly checkDestination: WebhookDestinationCheck;
  readonly now?: () => Date;
}

export class WebhooksService {
  readonly #repository: WebhooksRepository;
  readonly #keyring: Keyring;
  readonly #checkDestination: WebhookDestinationCheck;
  readonly #now: () => Date;

  constructor(
    repository: WebhooksRepository,
    keyring: Keyring,
    { checkDestination, now = () => new Date() }: WebhooksServiceOptions,
  ) {
    this.#repository = repository;
    this.#keyring = keyring;
    this.#checkDestination = checkDestination;
    this.#now = now;
  }

  async list({ tx }: BrandActor): Promise<WebhookList> {
    return { webhooks: (await this.#repository.list(tx)).map(toWebhook) };
  }

  /** The Developers page's table: each endpoint with its last day and last delivery. */
  async overview({ tx }: BrandActor): Promise<WebhookOverviewList> {
    const since = new Date(this.#now().getTime() - OVERVIEW_WINDOW_MS);
    const rows = await this.#repository.overview(tx, since);
    return {
      webhooks: rows.map((row) => ({
        ...toWebhook(row.webhook),
        createdByName: row.createdByName,
        last24h: { total: row.finished, succeeded: row.succeeded },
        lastDelivery: row.lastDelivery === null ? null : toWebhookDelivery(row.lastDelivery),
      })),
    };
  }

  async find({ tx }: BrandActor, webhookId: string): Promise<Webhook> {
    return toWebhook(await this.#require(tx, webhookId));
  }

  async create(actor: BrandActor, request: WebhookCreateRequest): Promise<WebhookWithSecret> {
    await this.#checkDestination(request.url);
    const secret = issueWebhookSecret();
    const row = await this.#repository.insert(actor.tx, {
      brandId: actor.brandId,
      url: request.url,
      description: request.description ?? '',
      events: [...request.events],
      secret: encryptSecret(secret, this.#keyring),
      createdBy: actor.principalType === 'staff' ? actor.principalId : null,
    });
    await this.#audit(actor, 'webhook.created', row.id, { url: row.url, events: row.events });

    return { ...toWebhook(row), secret };
  }

  /** Switching an endpoint back on starts its run of failures over. */
  async update(
    actor: BrandActor,
    webhookId: string,
    request: WebhookUpdateRequest,
  ): Promise<Webhook> {
    await this.#require(actor.tx, webhookId);
    if (request.url !== undefined) {
      await this.#checkDestination(request.url);
    }
    const row = await this.#repository.update(actor.tx, webhookId, {
      ...(request.url === undefined ? {} : { url: request.url }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.events === undefined ? {} : { events: [...request.events] }),
      ...(request.enabled === undefined
        ? {}
        : request.enabled
          ? { enabled: true, consecutiveFailures: 0, disabledAt: null, disabledReason: null }
          : { enabled: false, disabledAt: new Date(), disabledReason: null }),
    });
    /* c8 ignore next 3 -- the row was read in this transaction a moment ago. */
    if (row === undefined) {
      throw new NotFoundException('No such webhook');
    }
    await this.#audit(actor, 'webhook.updated', webhookId, { fields: Object.keys(request) });

    return toWebhook(row);
  }

  async remove(actor: BrandActor, webhookId: string): Promise<void> {
    if (!(await this.#repository.delete(actor.tx, webhookId))) {
      throw new NotFoundException('No such webhook');
    }
    await this.#audit(actor, 'webhook.deleted', webhookId);
  }

  /** A new secret, shown once. Deliveries signed from now on use it. */
  async rotateSecret(actor: BrandActor, webhookId: string): Promise<WebhookWithSecret> {
    await this.#require(actor.tx, webhookId);
    const secret = issueWebhookSecret();
    const row = await this.#repository.update(actor.tx, webhookId, {
      secret: encryptSecret(secret, this.#keyring),
      secretRotatedAt: new Date(),
    });
    /* c8 ignore next 3 -- the row was read in this transaction a moment ago. */
    if (row === undefined) {
      throw new NotFoundException('No such webhook');
    }
    await this.#audit(actor, 'webhook.secret_rotated', webhookId);

    return { ...toWebhook(row), secret };
  }

  async deliveries(
    { tx }: BrandActor,
    webhookId: string,
    query: WebhookDeliveryQuery,
  ): Promise<WebhookDeliveryList> {
    await this.#require(tx, webhookId);
    const limit = query.limit ?? WEBHOOK_DELIVERY_PAGE_SIZE;
    const rows = await this.#repository.deliveries(tx, webhookId, {
      before: query.cursor,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);

    return {
      deliveries: page.map(toWebhookDelivery),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * One delivery as it was sent: its body and the headers of its last attempt.
   * Before the first attempt there is no signature to show, so there is none.
   */
  async delivery(
    { tx }: BrandActor,
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryDetail> {
    const webhook = await this.#require(tx, webhookId);
    const row = await this.#repository.delivery(tx, webhookId, deliveryId);
    if (row === undefined) {
      throw new NotFoundException('No such delivery');
    }
    const headers =
      row.lastAttemptAt === null
        ? {}
        : webhookRequest(row, decryptSecret(webhook.secret, this.#keyring), row.lastAttemptAt)
            .headers;

    return {
      ...toWebhookDelivery(row),
      request: {
        method: 'POST',
        url: webhook.url,
        headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
        body: webhookRequestBody(row),
      },
    };
  }

  /**
   * "Send test event": a `ping` to this endpoint alone, through the same
   * outbox hop and the same `webhook.deliver` job as any event, so a passing
   * test means real deliveries will pass too.
   */
  async sendTest(actor: BrandActor, webhookId: string): Promise<WebhookDelivery> {
    const webhook = await this.#require(actor.tx, webhookId);
    const eventId = randomUUID();
    const delivery = await this.#repository.insertDelivery(actor.tx, {
      brandId: actor.brandId,
      webhookId,
      eventId,
      event: WEBHOOK_TEST_EVENT,
      payload: {
        id: eventId,
        event: WEBHOOK_TEST_EVENT,
        createdAt: this.#now().toISOString(),
        brandId: actor.brandId,
        data: { webhook: { id: webhook.id, url: webhook.url } },
      },
    });
    /* c8 ignore next 3 -- a fresh event id never meets the unique index. */
    if (delivery === undefined) {
      throw new Error('The test delivery insert returned no row');
    }
    await enqueueOutbox(actor.tx, {
      brandId: actor.brandId,
      event: WEBHOOK_DELIVERY_REQUESTED_EVENT,
      payload: { deliveryId: delivery.id },
    });
    await this.#audit(actor, 'webhook.tested', webhookId, { deliveryId: delivery.id });

    return toWebhookDelivery(delivery);
  }

  /**
   * Sends a delivery's frozen body again, as a new delivery with the same
   * event id, so a receiver that already processed it can tell.
   */
  async replay(actor: BrandActor, webhookId: string, deliveryId: string): Promise<WebhookDelivery> {
    const original = await this.#repository.delivery(actor.tx, webhookId, deliveryId);
    if (original === undefined) {
      throw new NotFoundException('No such delivery');
    }
    const replay = await this.#repository.insertDelivery(actor.tx, {
      brandId: actor.brandId,
      webhookId,
      eventId: original.eventId,
      event: original.event,
      payload: original.payload,
      replayOf: original.id,
    });
    /* c8 ignore next 3 -- a replay row is outside the unique index, so it always inserts. */
    if (replay === undefined) {
      throw new Error('The replay delivery insert returned no row');
    }
    await enqueueOutbox(actor.tx, {
      brandId: actor.brandId,
      event: WEBHOOK_DELIVERY_REQUESTED_EVENT,
      payload: { deliveryId: replay.id },
    });
    await this.#audit(actor, 'webhook.delivery_replayed', webhookId, {
      deliveryId: original.id,
      replayId: replay.id,
    });

    return toWebhookDelivery(replay);
  }

  async #require(tx: BrandActor['tx'], webhookId: string): Promise<WebhookRow> {
    const row = await this.#repository.find(tx, webhookId);
    if (row === undefined) {
      throw new NotFoundException('No such webhook');
    }
    return row;
  }

  async #audit(
    { tx, brandId, principalType, principalId }: BrandActor,
    action: WebhookAuditAction,
    webhookId: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: principalType,
      actorId: principalId,
      action,
      targetType: 'webhook',
      targetId: webhookId,
      meta,
    });
  }
}

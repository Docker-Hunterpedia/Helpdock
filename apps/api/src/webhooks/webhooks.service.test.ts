import { createKeyring, decryptSecret, encryptSecret } from '@helpdock/config';
import type { DbTransaction, WebhookDeliveryRow, WebhookRow } from '@helpdock/db';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrandActor } from '../context/brand-actor.js';
import { WEBHOOK_DELIVERY_REQUESTED_EVENT } from './webhook-events.js';
import { verifyWebhookSignature } from './webhook-signature.js';
import type { WebhooksRepository } from './webhooks.repository.js';
import { toWebhook, WebhooksService } from './webhooks.service.js';
import { WebhooksFailure } from './webhooks-failure.js';

const enqueueOutbox = vi.hoisted(() => vi.fn(async () => 'outbox-id'));
vi.mock('@helpdock/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@helpdock/jobs')>()),
  enqueueOutbox,
}));

const BRAND = '0192a000-0000-7000-8000-0000000000b1';
const KEY = '0192a000-0000-7000-8000-0000000000a1';
const WEBHOOK = '0192a000-0000-7000-8000-0000000000e1';
const DELIVERY = '0192a000-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-10-05T10:00:00Z');
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });

const webhookRow = (overrides: Partial<WebhookRow> = {}): WebhookRow => ({
  id: WEBHOOK,
  brandId: BRAND,
  url: 'https://hooks.example.com/helpdock',
  description: '',
  events: ['ticket.created'],
  secret: 'v1.sealed',
  secretRotatedAt: null,
  enabled: true,
  consecutiveFailures: 0,
  disabledAt: null,
  disabledReason: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const audits: Record<string, unknown>[] = [];
const tx = {
  insert: () => ({
    values: async (values: Record<string, unknown>) => {
      audits.push(values);
    },
  }),
} as unknown as DbTransaction;
/** The public API acting: its audit rows name the key. */
const keyActor: BrandActor = { tx, brandId: BRAND, principalType: 'apikey', principalId: KEY };

const checkDestination = vi.fn(async (_url: string) => {});

const service = (repository: Partial<Record<keyof WebhooksRepository, unknown>>) =>
  new WebhooksService(repository as unknown as WebhooksRepository, keyring, {
    checkDestination,
    now: () => NOW,
  });

const deliveryRow = (overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow => ({
  id: DELIVERY,
  brandId: BRAND,
  webhookId: WEBHOOK,
  eventId: '0192a000-0000-7000-8000-0000000000f1',
  event: 'ticket.created',
  payload: { id: 'evt', event: 'ticket.created' },
  status: 'failed',
  attempts: 8,
  responseStatus: 500,
  responseExcerpt: 'nope',
  durationMs: 120,
  error: 'The endpoint answered 500',
  replayOf: null,
  createdAt: NOW,
  lastAttemptAt: NOW,
  deliveredAt: null,
  ...overrides,
});

beforeEach(() => {
  audits.length = 0;
  vi.clearAllMocks();
});

describe('toWebhook', () => {
  it('never carries the secret, and says why Helpdock switched an endpoint off', () => {
    const view = toWebhook(webhookRow({ enabled: false, disabledReason: 'failures' }));

    expect(view).not.toHaveProperty('secret');
    expect(view.disabledReason).toBe('failures');
  });
});

describe('WebhooksService', () => {
  it('returns the signing secret once and stores it encrypted, auditing the key that asked', async () => {
    const insert = vi.fn(async (_tx: unknown, values: Partial<WebhookRow>) =>
      webhookRow({ ...values }),
    );

    const created = await service({ insert }).create(keyActor, {
      url: 'https://hooks.example.com/helpdock',
      events: ['ticket.created'],
    });

    const stored = insert.mock.calls[0]?.[1]?.secret ?? '';
    expect(created.secret).toMatch(/^whsec_/);
    expect(stored).not.toContain(created.secret);
    expect(decryptSecret(stored, keyring)).toBe(created.secret);
    expect(insert.mock.calls[0]?.[1]?.createdBy).toBeNull();
    expect(audits).toEqual([
      expect.objectContaining({ action: 'webhook.created', actorType: 'apikey', actorId: KEY }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(created.secret);
  });

  it('checks where a new or changed URL resolves before storing it', async () => {
    checkDestination.mockRejectedValueOnce(
      new WebhooksFailure('webhook-destination-blocked', '10.0.4.12'),
    );
    const insert = vi.fn();

    await expect(
      service({ insert }).create(keyActor, {
        url: 'https://billing.internal.example/hooks',
        events: ['ticket.created'],
      }),
    ).rejects.toMatchObject({ reason: 'webhook-destination-blocked', address: '10.0.4.12' });
    expect(insert).not.toHaveBeenCalled();

    const update = vi.fn(async () => webhookRow());
    await service({ find: vi.fn(async () => webhookRow()), update }).update(keyActor, WEBHOOK, {
      url: 'https://hooks.example.com/v2',
    });
    expect(checkDestination).toHaveBeenLastCalledWith('https://hooks.example.com/v2');
  });

  it('lists endpoints with their last day of finished deliveries and the newest one', async () => {
    const overview = vi.fn(async () => [
      {
        webhook: webhookRow(),
        createdByName: 'Omar',
        finished: 8,
        succeeded: 7,
        lastDelivery: deliveryRow(),
      },
    ]);

    const listed = await service({ overview }).overview(keyActor);

    expect(overview).toHaveBeenCalledWith(tx, new Date('2026-10-04T10:00:00Z'));
    expect(listed.webhooks[0]).toMatchObject({
      createdByName: 'Omar',
      last24h: { total: 8, succeeded: 7 },
      lastDelivery: { id: DELIVERY, responseStatus: 500 },
    });
    expect(listed.webhooks[0]).not.toHaveProperty('secret');
  });

  it('shows a delivery with the headers its last attempt carried, signature included', async () => {
    const secret = 'whsec_test';
    const webhook = webhookRow({ secret: encryptSecret(secret, keyring) });

    const detail = await service({
      find: vi.fn(async () => webhook),
      delivery: vi.fn(async () => deliveryRow()),
    }).delivery(keyActor, WEBHOOK, DELIVERY);

    const header = (name: string) =>
      detail.request.headers.find((candidate) => candidate.name === name)?.value ?? '';
    expect(detail.request).toMatchObject({ method: 'POST', url: webhook.url });
    expect(header('x-helpdock-delivery')).toBe(DELIVERY);
    expect(
      verifyWebhookSignature({
        secret,
        header: header('x-helpdock-signature'),
        body: detail.request.body,
        nowSeconds: NOW.getTime() / 1000,
      }),
    ).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(secret);
  });

  it('shows no headers for a delivery that was never attempted', async () => {
    const detail = await service({
      find: vi.fn(async () => webhookRow()),
      delivery: vi.fn(async () => deliveryRow({ lastAttemptAt: null, status: 'pending' })),
    }).delivery(keyActor, WEBHOOK, DELIVERY);

    expect(detail.request.headers).toEqual([]);
    expect(JSON.parse(detail.request.body)).toEqual({ id: 'evt', event: 'ticket.created' });
  });

  it('sends a test ping through the outbox like any delivery, and audits it', async () => {
    const insertDelivery = vi.fn(async (_tx: unknown, values: Partial<WebhookDeliveryRow>) =>
      deliveryRow({ ...values, status: 'pending', attempts: 0, lastAttemptAt: null }),
    );

    const ping = await service({ find: vi.fn(async () => webhookRow()), insertDelivery }).sendTest(
      keyActor,
      WEBHOOK,
    );

    const inserted = insertDelivery.mock.calls[0]?.[1];
    expect(inserted).toMatchObject({
      event: 'ping',
      payload: { event: 'ping', id: inserted?.eventId, brandId: BRAND },
    });
    expect(ping.event).toBe('ping');
    expect(enqueueOutbox).toHaveBeenCalledWith(tx, {
      brandId: BRAND,
      event: WEBHOOK_DELIVERY_REQUESTED_EVENT,
      payload: { deliveryId: ping.id },
    });
    expect(audits.map((audit) => audit.action)).toEqual(['webhook.tested']);
  });

  it('switching an endpoint back on starts its run of failures over', async () => {
    const update = vi.fn(async () => webhookRow());

    await service({ find: vi.fn(async () => webhookRow()), update }).update(keyActor, WEBHOOK, {
      enabled: true,
    });

    expect(update).toHaveBeenCalledWith(tx, WEBHOOK, {
      enabled: true,
      consecutiveFailures: 0,
      disabledAt: null,
      disabledReason: null,
    });
  });

  it('rotates to a new secret, shown once', async () => {
    const update = vi.fn(async (_tx: unknown, _id: string, changes: Partial<WebhookRow>) =>
      webhookRow(changes),
    );

    const rotated = await service({ find: vi.fn(async () => webhookRow()), update }).rotateSecret(
      keyActor,
      WEBHOOK,
    );

    expect(decryptSecret(update.mock.calls[0]?.[2]?.secret ?? '', keyring)).toBe(rotated.secret);
    expect(audits.map((audit) => audit.action)).toEqual(['webhook.secret_rotated']);
  });

  it('replays a delivery as a new one with the same event id, and asks for it to be sent', async () => {
    const original = {
      id: DELIVERY,
      webhookId: WEBHOOK,
      eventId: '0192a000-0000-7000-8000-0000000000f1',
      event: 'ticket.created',
      payload: { id: 'evt' },
    } as unknown as WebhookDeliveryRow;
    const insertDelivery = vi.fn(async (_tx: unknown, values: Record<string, unknown>) => ({
      ...original,
      ...values,
      id: '0192a000-0000-7000-8000-0000000000d2',
      status: 'pending',
      attempts: 0,
      createdAt: NOW,
    }));

    const replay = await service({
      delivery: vi.fn(async () => original),
      insertDelivery,
    }).replay(keyActor, WEBHOOK, DELIVERY);

    expect(insertDelivery.mock.calls[0]?.[1]).toMatchObject({
      eventId: original.eventId,
      payload: original.payload,
      replayOf: DELIVERY,
    });
    expect(replay.replayOf).toBe(DELIVERY);
    expect(enqueueOutbox).toHaveBeenCalledWith(tx, {
      brandId: BRAND,
      event: WEBHOOK_DELIVERY_REQUESTED_EVENT,
      payload: { deliveryId: replay.id },
    });
  });

  it('answers 404 for an endpoint or a delivery this brand does not have', async () => {
    const missing = service({
      find: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
      delivery: vi.fn(async () => undefined),
    });
    const noDelivery = service({
      find: vi.fn(async () => webhookRow()),
      delivery: vi.fn(async () => undefined),
    });

    await expect(missing.find(keyActor, WEBHOOK)).rejects.toBeInstanceOf(NotFoundException);
    await expect(missing.remove(keyActor, WEBHOOK)).rejects.toBeInstanceOf(NotFoundException);
    await expect(missing.replay(keyActor, WEBHOOK, DELIVERY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(missing.sendTest(keyActor, WEBHOOK)).rejects.toBeInstanceOf(NotFoundException);
    await expect(noDelivery.delivery(keyActor, WEBHOOK, DELIVERY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

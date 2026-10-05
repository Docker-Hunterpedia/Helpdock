import { createKeyring, decryptSecret } from '@helpdock/config';
import type { DbTransaction, WebhookDeliveryRow, WebhookRow } from '@helpdock/db';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrandActor } from '../context/brand-actor.js';
import { WEBHOOK_DELIVERY_REQUESTED_EVENT } from './webhook-events.js';
import type { WebhooksRepository } from './webhooks.repository.js';
import { toWebhook, WebhooksService } from './webhooks.service.js';

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

const service = (repository: Partial<Record<keyof WebhooksRepository, unknown>>) =>
  new WebhooksService(repository as unknown as WebhooksRepository, keyring);

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

    await expect(missing.find(keyActor, WEBHOOK)).rejects.toBeInstanceOf(NotFoundException);
    await expect(missing.remove(keyActor, WEBHOOK)).rejects.toBeInstanceOf(NotFoundException);
    await expect(missing.replay(keyActor, WEBHOOK, DELIVERY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

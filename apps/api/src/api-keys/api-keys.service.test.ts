import type { ApiKeyRow, DbTransaction } from '@helpdock/db';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { hashApiKey } from './api-key-credential.js';
import type { ApiKeysRepository } from './api-keys.repository.js';
import { ApiKeysService, toApiKey } from './api-keys.service.js';

const BRAND = '0192a000-0000-7000-8000-0000000000b1';
const ADMIN = '0192a000-0000-7000-8000-0000000000a1';
const KEY_ID = '0192a000-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-05T10:00:00Z');

const row = (overrides: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: KEY_ID,
  brandId: BRAND,
  name: 'CRM sync',
  prefix: 'hd_live_abcd',
  keyHash: 'hash',
  scopes: ['tickets:read'],
  rateLimitPerMinute: 600,
  createdBy: ADMIN,
  createdAt: NOW,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
  ...overrides,
});

/** Records every audit row the service writes. */
const auditingTx = () => {
  const audits: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        audits.push(values);
      },
    }),
  } as unknown as DbTransaction;
  return { tx, audits };
};

describe('toApiKey', () => {
  it('shows the prefix and never the hash, and drops a scope that is no longer known', () => {
    const view = toApiKey(row({ scopes: ['tickets:read', 'retired:scope'] }));

    expect(view.scopes).toEqual(['tickets:read']);
    expect(JSON.stringify(view)).not.toContain('hash');
    expect(view.prefix).toBe('hd_live_abcd');
  });
});

describe('ApiKeysService', () => {
  it('issues a key, stores only its hash, and audits the prefix and scopes', async () => {
    const insert = vi.fn(async (_tx: DbTransaction, values: Partial<ApiKeyRow>) =>
      row({ ...values }),
    );
    const service = new ApiKeysService({ insert } as unknown as ApiKeysRepository);
    const { tx, audits } = auditingTx();

    const created = await service.create(
      { tx, brandId: BRAND, userId: ADMIN },
      { name: 'CRM sync', scopes: ['tickets:read', 'tickets:write'] },
    );

    const stored = insert.mock.calls[0]?.[1];
    expect(stored?.keyHash).toBe(hashApiKey(created.key));
    expect(stored?.prefix).toBe(created.key.slice(0, 12));
    expect(stored?.rateLimitPerMinute).toBe(600);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'api_key.created',
        actorType: 'staff',
        actorId: ADMIN,
        targetType: 'api_key',
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(created.key);
  });

  it('revokes a live key once, and answers an already revoked one without a second audit', async () => {
    const revoked = row({ revokedAt: NOW });
    const repository = {
      find: vi.fn(async () => revoked),
      revoke: vi.fn().mockResolvedValueOnce(revoked).mockResolvedValueOnce(undefined),
    };
    const service = new ApiKeysService(repository as unknown as ApiKeysRepository);
    const { tx, audits } = auditingTx();
    const actor = { tx, brandId: BRAND, userId: ADMIN };

    expect((await service.revoke(actor, KEY_ID)).revokedAt).toBe(NOW.toISOString());
    expect((await service.revoke(actor, KEY_ID)).revokedAt).toBe(NOW.toISOString());
    expect(audits.map((audit) => audit.action)).toEqual(['api_key.revoked']);
  });

  it('answers 404 for a key this brand does not have', async () => {
    const service = new ApiKeysService({
      find: vi.fn(async () => undefined),
    } as unknown as ApiKeysRepository);

    await expect(
      service.revoke({ tx: auditingTx().tx, brandId: BRAND, userId: ADMIN }, KEY_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

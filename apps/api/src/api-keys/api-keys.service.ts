import { type ApiKeyRow, auditLog, type DbTransaction } from '@helpdock/db';
import {
  API_KEY_RATE_LIMIT_DEFAULT,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeyCreateRequest,
  type ApiKeyList,
  apiScopeSchema,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { issueApiKey } from './api-key-credential.js';
import type { ApiKeysRepository } from './api-keys.repository.js';

/**
 * M8-01: a brand's API keys, managed by its Admin. A key is shown once, on
 * create; afterwards only its prefix is. Revoking is final — a key that should
 * work again is a new key — and both are written to `audit_log` in the same
 * transaction as the change.
 */

export interface ApiKeyActor {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly userId: string;
}

export const toApiKey = (row: ApiKeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  // Stored as text so a scope can be retired without a migration; one that is
  // no longer known is dropped from the answer rather than failing the list.
  scopes: row.scopes.flatMap((scope) => {
    const parsed = apiScopeSchema.safeParse(scope);
    return parsed.success ? [parsed.data] : [];
  }),
  rateLimitPerMinute: row.rateLimitPerMinute,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

export class ApiKeysService {
  readonly #repository: ApiKeysRepository;

  constructor(repository: ApiKeysRepository) {
    this.#repository = repository;
  }

  async list({ tx }: ApiKeyActor): Promise<ApiKeyList> {
    return { keys: (await this.#repository.list(tx)).map(toApiKey) };
  }

  async create(actor: ApiKeyActor, request: ApiKeyCreateRequest): Promise<ApiKeyCreated> {
    const issued = issueApiKey();
    const row = await this.#repository.insert(actor.tx, {
      brandId: actor.brandId,
      name: request.name,
      prefix: issued.prefix,
      keyHash: issued.hash,
      scopes: [...request.scopes],
      rateLimitPerMinute: request.rateLimitPerMinute ?? API_KEY_RATE_LIMIT_DEFAULT,
      createdBy: actor.userId,
    });
    await this.#audit(actor, 'api_key.created', row);

    return { ...toApiKey(row), key: issued.key };
  }

  async revoke(actor: ApiKeyActor, keyId: string): Promise<ApiKey> {
    const existing = await this.#repository.find(actor.tx, keyId);
    if (existing === undefined) {
      throw new NotFoundException('No such API key');
    }
    // Already revoked: the answer is the same key, and nothing is audited twice.
    const row = await this.#repository.revoke(actor.tx, keyId, actor.userId);
    if (row === undefined) {
      return toApiKey(existing);
    }
    await this.#audit(actor, 'api_key.revoked', row);

    return toApiKey(row);
  }

  /** The prefix and the scopes, never the key or its hash. */
  async #audit(
    { tx, brandId, userId }: ApiKeyActor,
    action: 'api_key.created' | 'api_key.revoked',
    row: ApiKeyRow,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: userId,
      action,
      targetType: 'api_key',
      targetId: row.id,
      meta: { name: row.name, prefix: row.prefix, scopes: row.scopes },
    });
  }
}

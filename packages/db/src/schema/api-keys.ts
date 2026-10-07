import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { users } from './users.js';

/**
 * A brand's API keys (M8-01, ARCHITECTURE §7): `hd_live_<random>`, shown once
 * and stored as its SHA-256 only. `prefix` is the first characters of the key,
 * kept so the Admin can tell two keys apart without the key itself.
 *
 * `key_hash` is unique across the install, because a request names nothing but
 * the key: the hash alone has to find the brand, as a mailbox address does for
 * inbound parse.
 *
 * `scopes` are the API scopes of REQUIREMENTS §4.11 (`tickets:read`, …), which
 * are also the permission names the `/api/v1` routes require.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /** Requests per minute this key may make before it is answered 429. */
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(600),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Written at most once a minute, so a busy key is not a write per request. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('api_keys_key_hash_key').on(table.keyHash),
    index('api_keys_brand_created_idx').on(table.brandId, table.createdAt),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * M8-02: the `Idempotency-Key` of a `POST` to `/api/v1`, with the answer the
 * first request got, for 24 hours. Written in the request's own transaction,
 * so a request that fails leaves no key behind, and a second request with the
 * same key waits on the first one's unique index entry and then replays it.
 */
export const apiIdempotencyKeys = pgTable(
  'api_idempotency_keys',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** SHA-256 of method, path and body: the same key with another request is refused. */
    requestHash: text('request_hash').notNull(),
    /** The JSON the handler returned; null only while the first request is still running. */
    response: text('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_idempotency_keys_key').on(table.apiKeyId, table.key),
    index('api_idempotency_keys_brand_created_idx').on(table.brandId, table.createdAt),
  ],
);

export type ApiIdempotencyKeyRow = typeof apiIdempotencyKeys.$inferSelect;

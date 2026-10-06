import { type Keyring, rotateSecret, SecretDecryptionError } from '@helpdock/config';
import { sql } from 'drizzle-orm';
import type { Db, DbTransaction } from './client.js';
import { auditLog } from './schema/audit-log.js';
import { brands } from './schema/brands.js';
import { INSTALL_SCOPE_BRAND_ID, withTenant } from './tenant.js';

/**
 * Master key rotation (DOMAIN-RULES §10): every `v1.<keyId>.…` envelope the
 * database holds, re-encrypted under `APP_MASTER_KEY` from whichever key in the
 * keyring wrote it.
 *
 * Where envelopes live is a list rather than a search, because a search would
 * have to read every text column of every table, message bodies included.
 * `master-key-rotation.test.ts` fails when the schema gains a column whose name
 * says secret, password, token or encrypted and that is on neither list.
 */

/** A text column whose non-null values are all envelopes. */
interface EnvelopeColumn {
  readonly table: string;
  readonly column: string;
}

export const ENVELOPE_COLUMNS: readonly EnvelopeColumn[] = [
  { table: 'users', column: 'totp_secret_encrypted' },
  { table: 'email_outbound_settings', column: 'smtp_password' },
  { table: 'mailboxes', column: 'imap_password' },
  { table: 'inbound_parse_settings', column: 'secret' },
  { table: 'widget_settings', column: 'signing_secret' },
  { table: 'telegram_bots', column: 'token' },
  { table: 'telegram_bots', column: 'webhook_secret' },
  { table: 'webhooks', column: 'secret' },
  { table: 'knowledge_sources', column: 'config_encrypted' },
];

/**
 * Columns whose names look like a secret and which hold no envelope, with the
 * reason. A hash cannot be re-encrypted and needs no key to be checked.
 */
export const NOT_ENVELOPE_COLUMNS: readonly (EnvelopeColumn & { readonly reason: string })[] = [
  {
    table: 'users',
    column: 'password_hash',
    reason: 'argon2id with a pepper derived from the master key; replaced at the next sign-in',
  },
  { table: 'csat_responses', column: 'token_hash', reason: 'SHA-256 of the survey link' },
  { table: 'widget_visitors', column: 'secret_hash', reason: 'SHA-256 of the visitor secret' },
  {
    table: 'brand_domains',
    column: 'txt_token',
    reason: 'published in DNS on purpose; not a secret',
  },
  {
    table: 'ticket_search_tokens',
    column: 'token',
    reason: 'a word of a ticket, indexed for search',
  },
  {
    table: 'settings',
    column: 'value',
    reason: 'holds JSON for most keys; rotated by its own pass, which picks out the envelopes',
  },
];

/** The rows the `settings` pass reads: a JSON value can never start with `v1.`. */
const SETTINGS_ENVELOPE_PREFIX = 'v1.%';

/**
 * Where an envelope sits inside a JSON payload: `auth.email_requested` carries
 * the sign-in or reset link sealed (`apps/api/src/auth/auth-email.ts`). Only
 * rows the relay has not yet published are rotated; a published one has
 * already been handed to the queue, which reads it while the previous key is
 * still set.
 */
const OUTBOX_ENVELOPE_FIELD = 'urlEncrypted';

/** What one place held before the rotation. */
export interface RotationCount {
  readonly place: string;
  /** Re-encrypted under the current key. */
  readonly rotated: number;
  /** Already under the current key. */
  readonly current: number;
}

export interface RotationReport {
  readonly currentKeyId: string;
  readonly previousKeyId: string | null;
  readonly counts: readonly RotationCount[];
  readonly rotated: number;
}

/** Thrown, and the transaction rolled back, when a stored value cannot be read with either key. */
export class MasterKeyRotationError extends Error {
  readonly places: readonly string[];

  constructor(places: readonly string[]) {
    super(
      `Could not decrypt values in ${places.join(', ')} with APP_MASTER_KEY or APP_MASTER_KEY_PREVIOUS. Nothing was changed. Set APP_MASTER_KEY_PREVIOUS to the key those values were written with and run the rotation again.`,
    );
    this.name = 'MasterKeyRotationError';
    this.places = places;
  }
}

const ROTATION_PRINCIPAL = 'keys-rotate';
export const MASTER_KEY_ROTATED_ACTION = 'install.master_key_rotated';

type StoredValue = Record<string, unknown> & { readonly value: string };

type Rewrite = (tx: DbTransaction, from: string, to: string) => Promise<void>;

const rotateValues = async (
  tx: DbTransaction,
  place: string,
  values: readonly string[],
  keyring: Keyring,
  rewrite: Rewrite,
  unreadable: string[],
): Promise<RotationCount> => {
  let rotated = 0;
  let current = 0;
  for (const value of values) {
    let next: string;
    try {
      next = rotateSecret(value, keyring);
    } catch (error) {
      if (!(error instanceof SecretDecryptionError)) {
        throw error;
      }
      unreadable.push(place);
      break;
    }

    if (next === value) {
      current += 1;
    } else {
      // Matched on the old value rather than a key: envelopes carry a random
      // IV, so the value names its row, and a writer that replaced it in the
      // meantime used the current key already.
      await rewrite(tx, value, next);
      rotated += 1;
    }
  }

  return { place, rotated, current };
};

const valuesOf = (rows: Iterable<StoredValue>): string[] => [...rows].map((row) => row.value);

const rotateColumn = async (
  tx: DbTransaction,
  { table, column }: EnvelopeColumn,
  keyring: Keyring,
  unreadable: string[],
): Promise<RotationCount> => {
  const rows = await tx.execute<StoredValue>(
    sql`SELECT ${sql.identifier(column)} AS value FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} IS NOT NULL`,
  );

  return rotateValues(
    tx,
    `${table}.${column}`,
    valuesOf(rows),
    keyring,
    async (inner, from, to) => {
      await inner.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${to} WHERE ${sql.identifier(column)} = ${from}`,
      );
    },
    unreadable,
  );
};

const rotateSettings = async (
  tx: DbTransaction,
  keyring: Keyring,
  unreadable: string[],
): Promise<RotationCount> => {
  const rows = await tx.execute<StoredValue>(
    sql`SELECT value FROM settings WHERE value LIKE ${SETTINGS_ENVELOPE_PREFIX}`,
  );

  return rotateValues(
    tx,
    'settings.value',
    valuesOf(rows),
    keyring,
    async (inner, from, to) => {
      await inner.execute(sql`UPDATE settings SET value = ${to} WHERE value = ${from}`);
    },
    unreadable,
  );
};

const rotateOutbox = async (
  tx: DbTransaction,
  keyring: Keyring,
  unreadable: string[],
): Promise<RotationCount> => {
  const rows = await tx.execute<StoredValue>(
    sql`SELECT payload->>${OUTBOX_ENVELOPE_FIELD} AS value FROM outbox
        WHERE published_at IS NULL AND payload ? ${OUTBOX_ENVELOPE_FIELD}`,
  );

  return rotateValues(
    tx,
    `outbox.payload.${OUTBOX_ENVELOPE_FIELD}`,
    valuesOf(rows),
    keyring,
    async (inner, from, to) => {
      await inner.execute(
        sql`UPDATE outbox SET payload = jsonb_set(payload, ${`{${OUTBOX_ENVELOPE_FIELD}}`}::text[], to_jsonb(${to}::text))
            WHERE published_at IS NULL AND payload->>${OUTBOX_ENVELOPE_FIELD} = ${from}`,
      );
    },
    unreadable,
  );
};

/**
 * Re-encrypts every stored envelope under the keyring's current key, in one
 * transaction, and records the run in the install-scope audit log.
 *
 * It runs as the runtime role, so row-level security still applies: the
 * transaction names every brand and the install scope, which is the widest
 * context there is and the reason this is a command an operator runs by hand
 * rather than a job. A value no key in the keyring opens rolls the whole run
 * back with {@link MasterKeyRotationError}. Run without a previous key, it
 * changes nothing and reports whether anything still needs one.
 */
export const rotateMasterKey = async (db: Db, keyring: Keyring): Promise<RotationReport> => {
  const brandIds = (await db.select({ id: brands.id }).from(brands)).map(({ id }) => id);

  return withTenant(
    db,
    {
      brandIds: [INSTALL_SCOPE_BRAND_ID, ...brandIds],
      departmentIds: 'all',
      principalType: 'system',
      principalId: ROTATION_PRINCIPAL,
    },
    async (tx) => {
      const unreadable: string[] = [];
      const counts: RotationCount[] = [];
      for (const column of ENVELOPE_COLUMNS) {
        counts.push(await rotateColumn(tx, column, keyring, unreadable));
      }
      counts.push(await rotateSettings(tx, keyring, unreadable));
      counts.push(await rotateOutbox(tx, keyring, unreadable));

      if (unreadable.length > 0) {
        throw new MasterKeyRotationError(unreadable);
      }

      const report: RotationReport = {
        currentKeyId: keyring.current.id,
        previousKeyId: keyring.previous?.id ?? null,
        counts,
        rotated: counts.reduce((sum, count) => sum + count.rotated, 0),
      };

      await tx.insert(auditLog).values({
        brandId: INSTALL_SCOPE_BRAND_ID,
        actorType: 'system',
        actorId: ROTATION_PRINCIPAL,
        action: MASTER_KEY_ROTATED_ACTION,
        targetType: 'install',
        meta: {
          currentKeyId: report.currentKeyId,
          previousKeyId: report.previousKeyId,
          rotated: report.rotated,
        },
      });

      return report;
    },
  );
};

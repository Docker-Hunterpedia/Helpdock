import type { StoredSetting } from '@helpdock/config';
import { type SettingKey, type SettingsStore, settingDefinitions } from '@helpdock/config';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { type Setting, settings } from './schema/settings.js';
import { INSTALL_SCOPE_BRAND_ID, withSystem } from './tenant.js';
import { isUuid } from './uuid.js';

/**
 * The database half of ARCHITECTURE §4, behind the `SettingsStore` interface
 * `@helpdock/config` defines. The scope is bound once, at construction, because
 * that is the shape the interface asks for: a row is addressed by key alone.
 *
 * Reads and writes open their own system transaction. Settings are resolved at
 * boot and again on invalidation, outside any request, so there is no ambient
 * tenant context to join; `withSystem` supplies one for this scope alone.
 *
 * The store reads and writes exactly its own scope. Falling back from a brand
 * override to the install-wide value is a resolution rule, and belongs to
 * whichever milestone introduces per-brand settings in admin, not here.
 */
export interface PostgresSettingsStoreOptions {
  readonly db: Db;
  /** The brand whose overrides this store holds; null or omitted for install scope. */
  readonly brandId?: string | null;
}

const isKnownKey = (key: string): key is SettingKey => Object.hasOwn(settingDefinitions, key);

const toStoredSetting = (row: Setting): StoredSetting | undefined =>
  isKnownKey(row.key)
    ? { key: row.key, value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
    : undefined;

export class PostgresSettingsStore implements SettingsStore {
  readonly #db: Db;
  readonly #brandId: string;

  constructor({ db, brandId = null }: PostgresSettingsStoreOptions) {
    if (brandId !== null && !isUuid(brandId)) {
      throw new TypeError(
        'PostgresSettingsStore expects a UUID brand id, or null for install scope',
      );
    }

    this.#db = db;
    this.#brandId = brandId ?? INSTALL_SCOPE_BRAND_ID;
  }

  /** The brand this store is bound to, or null when it holds install-wide values. */
  get brandId(): string | null {
    return this.#brandId === INSTALL_SCOPE_BRAND_ID ? null : this.#brandId;
  }

  async read(key: SettingKey): Promise<StoredSetting | undefined> {
    const rows = await withSystem(this.#db, this.#brandId, (tx) =>
      tx
        .select()
        .from(settings)
        .where(and(eq(settings.key, key), eq(settings.brandId, this.#brandId)))
        .limit(1),
    );

    const row = rows[0];
    return row === undefined ? undefined : toStoredSetting(row);
  }

  async write(setting: StoredSetting): Promise<void> {
    await withSystem(this.#db, this.#brandId, async (tx) => {
      await tx
        .insert(settings)
        .values({
          key: setting.key,
          brandId: this.#brandId,
          value: setting.value,
          updatedBy: setting.updatedBy,
          updatedAt: setting.updatedAt,
        })
        .onConflictDoUpdate({
          target: [settings.key, settings.brandId],
          set: {
            value: setting.value,
            updatedBy: setting.updatedBy,
            updatedAt: setting.updatedAt,
          },
        });
    });
  }

  async list(): Promise<StoredSetting[]> {
    const rows = await withSystem(this.#db, this.#brandId, (tx) =>
      tx.select().from(settings).where(eq(settings.brandId, this.#brandId)),
    );

    // A key the registry no longer declares stays in the table, so that a
    // downgrade does not lose it, but it is not a `SettingKey` and does not
    // belong in a typed result.
    return rows.map(toStoredSetting).filter((row) => row !== undefined);
  }
}

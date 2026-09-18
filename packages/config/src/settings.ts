import { decryptSecret, encryptSecret, type Keyring } from './crypto.js';
import type { EnvSource } from './env.js';
import type { Invalidation } from './invalidation.js';
import {
  SETTING_DEFINITIONS,
  type SettingKey,
  type SettingScope,
  type SettingValue,
  type SettingValues,
  settingDefinitions,
} from './registry.js';

/**
 * One row of the `settings` table. `value` is the JSON encoding of the setting,
 * or the `v1.…` envelope from `encryptSecret` when the key is a secret.
 */
export interface StoredSetting {
  readonly key: SettingKey;
  readonly value: string;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

/**
 * Persistence for settings, kept free of any database type so that
 * `packages/config` does not depend on Drizzle or Postgres. The Postgres store
 * that arrives with M0-03 implements this interface as it stands: a row is
 * addressed by key alone, and a brand-scoped store is one instance bound to a
 * brand rather than a wider signature.
 */
export interface SettingsStore {
  read(key: SettingKey): Promise<StoredSetting | undefined>;
  write(setting: StoredSetting): Promise<void>;
  list(): Promise<StoredSetting[]>;
}

/** The store used by tests and by a dev run with no database yet. */
export class InMemorySettingsStore implements SettingsStore {
  readonly #rows = new Map<SettingKey, StoredSetting>();

  read(key: SettingKey): Promise<StoredSetting | undefined> {
    return Promise.resolve(this.#rows.get(key));
  }

  write(setting: StoredSetting): Promise<void> {
    this.#rows.set(setting.key, setting);
    return Promise.resolve();
  }

  list(): Promise<StoredSetting[]> {
    return Promise.resolve([...this.#rows.values()]);
  }
}

/** Thrown by `set` for a key the environment has pinned (ARCHITECTURE §4). */
export class SettingLockedError extends Error {
  readonly key: SettingKey;
  readonly envKey: string;

  constructor(key: SettingKey, envKey: string) {
    super(`Setting ${key} is locked by the environment variable ${envKey} and cannot be changed`);
    this.name = 'SettingLockedError';
    this.key = key;
    this.envKey = envKey;
  }
}

/**
 * Thrown by `set` for a value the key's schema rejects. Zod issue messages
 * describe types and bounds, never the value, so this is safe for secret keys.
 */
export class SettingValidationError extends Error {
  readonly key: SettingKey;
  readonly issues: readonly string[];

  constructor(key: SettingKey, issues: readonly string[]) {
    super(`Invalid value for setting ${key}: ${issues.join('; ')}`);
    this.name = 'SettingValidationError';
    this.key = key;
    this.issues = issues;
  }
}

/** Thrown when a stored row cannot be read back into a value of the right shape. */
export class SettingDecodeError extends Error {
  readonly key: SettingKey;

  constructor(key: SettingKey, reason: string) {
    super(`Stored value for setting ${key} could not be decoded: ${reason}`);
    this.name = 'SettingDecodeError';
    this.key = key;
  }
}

/** Thrown at construction when an `HD_*` override does not satisfy its key's schema. */
export class EnvOverrideError extends Error {
  readonly envKeys: readonly string[];

  constructor(envKeys: readonly string[]) {
    super(`Invalid setting overrides in the environment: ${envKeys.join(', ')}`);
    this.name = 'EnvOverrideError';
    this.envKeys = envKeys;
  }
}

export interface CreateSettingsOptions {
  /** The raw process environment. An `HD_*` entry overrides and locks its setting. */
  readonly env?: EnvSource;
  readonly store: SettingsStore;
  readonly keyring: Keyring;
  readonly invalidation: Invalidation;
}

export interface SetOptions {
  /** User id, or a system actor such as `wizard`, recorded on the row. */
  readonly updatedBy: string;
}

export interface GetAllOptions {
  readonly scope?: SettingScope;
  /**
   * Include the decrypted value of secret keys. Server-side use only: the
   * result of an `includeSecrets` call must never reach a response DTO.
   */
  readonly includeSecrets?: boolean;
}

export interface Settings {
  get<TKey extends SettingKey>(key: TKey): Promise<SettingValue<TKey>>;
  getAll(options?: GetAllOptions): Promise<Partial<SettingValues>>;
  set<TKey extends SettingKey>(
    key: TKey,
    value: SettingValue<TKey>,
    options: SetOptions,
  ): Promise<void>;
  isLockedByEnv(key: SettingKey): boolean;
  /** Notifies on every invalidation, local or from another replica. */
  subscribe(listener: (key: SettingKey) => void): () => void;
  /** Detaches from the invalidation channel. The channel itself is the caller's to close. */
  close(): Promise<void>;
}

// The environment only carries strings; the declared default says what shape
// the key holds. An unparseable value is passed through so the key's own schema
// produces the error rather than a silent `false` or `NaN`.
const coerceEnvValue = (raw: string, defaultValue: unknown): unknown => {
  if (typeof defaultValue === 'boolean') {
    if (raw === 'true') {
      return true;
    }
    return raw === 'false' ? false : raw;
  }

  return typeof defaultValue === 'number' ? Number(raw) : raw;
};

const readEnvOverrides = (env: EnvSource): ReadonlyMap<SettingKey, unknown> => {
  const overrides = new Map<SettingKey, unknown>();
  const invalid: string[] = [];

  for (const definition of SETTING_DEFINITIONS) {
    const raw = env[definition.envKey]?.trim();
    if (raw === undefined || raw === '') {
      continue;
    }

    const parsed = definition.schema.safeParse(coerceEnvValue(raw, definition.default));
    if (parsed.success) {
      overrides.set(definition.key, parsed.data);
    } else {
      invalid.push(definition.envKey);
    }
  }

  if (invalid.length > 0) {
    throw new EnvOverrideError(invalid);
  }

  return overrides;
};

const decodeStored = (key: SettingKey, stored: StoredSetting, keyring: Keyring): unknown => {
  const definition = settingDefinitions[key];
  const encoded = definition.secret ? decryptSecret(stored.value, keyring) : stored.value;

  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    throw new SettingDecodeError(key, 'it is not valid JSON');
  }

  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingDecodeError(key, 'it no longer satisfies the schema for this key');
  }

  return parsed.data;
};

/**
 * Resolves settings in the order ARCHITECTURE §4 defines: an environment
 * override (which also locks the key) beats a stored value, which beats the
 * registry default. Resolved values are cached in process and dropped again on
 * the next invalidation, so a change in admin reaches every replica without a
 * restart.
 */
export const createSettings = ({
  env = process.env,
  store,
  keyring,
  invalidation,
}: CreateSettingsOptions): Settings => {
  const overrides = readEnvOverrides(env);
  const cache = new Map<SettingKey, unknown>();
  const listeners = new Set<(key: SettingKey) => void>();

  const unsubscribe = invalidation.subscribe((key) => {
    cache.delete(key);
    for (const listener of listeners) {
      listener(key);
    }
  });

  const resolve = async (key: SettingKey): Promise<unknown> => {
    if (overrides.has(key)) {
      return overrides.get(key);
    }
    if (cache.has(key)) {
      return cache.get(key);
    }

    const stored = await store.read(key);
    const value =
      stored === undefined ? settingDefinitions[key].default : decodeStored(key, stored, keyring);
    cache.set(key, value);
    return value;
  };

  return {
    async get(key) {
      // `resolve` is untyped because it walks the registry at runtime; the
      // schema it parses with is the one that defines `SettingValue<TKey>`.
      return (await resolve(key)) as SettingValue<typeof key>;
    },

    async getAll({ scope, includeSecrets = false }: GetAllOptions = {}) {
      const wanted = SETTING_DEFINITIONS.filter(
        (definition) =>
          (scope === undefined || definition.scope === scope) &&
          (includeSecrets || !definition.secret),
      );
      const entries = await Promise.all(
        wanted.map(async (definition) => [definition.key, await resolve(definition.key)] as const),
      );

      return Object.fromEntries(entries) as Partial<SettingValues>;
    },

    async set(key, value, { updatedBy }) {
      const definition = settingDefinitions[key];
      if (overrides.has(key)) {
        throw new SettingLockedError(key, definition.envKey);
      }

      const parsed = definition.schema.safeParse(value);
      if (!parsed.success) {
        throw new SettingValidationError(
          key,
          parsed.error.issues.map((issue) => issue.message),
        );
      }

      const encoded = JSON.stringify(parsed.data);
      await store.write({
        key,
        value: definition.secret ? encryptSecret(encoded, keyring) : encoded,
        updatedAt: new Date(),
        updatedBy,
      });

      cache.delete(key);
      await invalidation.publish(key);
    },

    isLockedByEnv(key) {
      return overrides.has(key);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close() {
      unsubscribe();
      listeners.clear();
      cache.clear();
      return Promise.resolve();
    },
  };
};

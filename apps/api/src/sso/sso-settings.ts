import {
  decryptSecret,
  encryptSecret,
  type Keyring,
  type SettingKey,
  type Settings,
  type SettingValue,
  settingDefinitions,
} from '@helpdock/config';
import {
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  settings as settingsTable,
} from '@helpdock/db';
import { and, eq } from 'drizzle-orm';

export type SsoSettingKey = Extract<SettingKey, `sso.${string}`>;

/** Read from the transaction rather than a cache: enforcement must see the committed connection/settings pair. */
export async function readSsoSetting<K extends SsoSettingKey>(
  tx: DbTransaction,
  resolver: Settings,
  keyring: Keyring,
  key: K,
): Promise<SettingValue<K>> {
  if (resolver.isLockedByEnv(key)) return resolver.get(key);
  const [stored] = await tx
    .select()
    .from(settingsTable)
    .where(and(eq(settingsTable.brandId, INSTALL_SCOPE_BRAND_ID), eq(settingsTable.key, key)));
  const definition = settingDefinitions[key];
  const decoded: unknown =
    stored === undefined
      ? definition.default
      : JSON.parse(definition.secret ? decryptSecret(stored.value, keyring) : stored.value);
  return definition.schema.parse(decoded) as SettingValue<K>;
}

export async function writeSsoSetting<K extends SsoSettingKey>(
  tx: DbTransaction,
  keyring: Keyring,
  change: { key: K; value: SettingValue<K>; actorId: string },
): Promise<void> {
  const { key, value, actorId } = change;
  const definition = settingDefinitions[key];
  const encoded = JSON.stringify(definition.schema.parse(value));
  const stored = definition.secret ? encryptSecret(encoded, keyring) : encoded;
  await tx
    .insert(settingsTable)
    .values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      key,
      value: stored,
      updatedBy: actorId,
    })
    .onConflictDoUpdate({
      target: [settingsTable.key, settingsTable.brandId],
      set: { value: stored, updatedBy: actorId, updatedAt: new Date() },
    });
}

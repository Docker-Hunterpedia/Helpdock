import {
  brands,
  type DbTransaction,
  settings,
  users,
  type WidgetSettingsRow,
  widgetSettings,
} from '@helpdock/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Reads and writes behind Channels › Widget and every widget request. Each
 * method takes the transaction it runs in: the admin's request transaction,
 * or the brand-scoped system transaction a visitor's request opens.
 */

/** The brand facts a widget request needs besides its widget row. */
export interface WidgetBrand {
  readonly id: string;
  readonly name: string;
  readonly defaultLocale: 'en' | 'ar';
  readonly timezone: string;
  readonly status: 'active' | 'deleting' | 'deleted';
  /** `brands.settings.contentPolicy`, unparsed (M1-10). */
  readonly contentPolicy: unknown;
}

/** The `captcha.*` settings rows of a brand (ADR 0003), as stored. */
export interface StoredCaptcha {
  readonly provider: string | undefined;
  readonly siteKey: string | undefined;
  /** The `v1.…` envelope, never decrypted here. */
  readonly secret: string | undefined;
  readonly secretSetAt: Date | null;
  readonly secretSetBy: string | null;
}

export const CAPTCHA_KEYS = {
  provider: 'captcha.provider',
  siteKey: 'captcha.siteKey',
  secret: 'captcha.secret',
} as const;

export class WidgetSettingsRepository {
  async brand(tx: DbTransaction, brandId: string): Promise<WidgetBrand | undefined> {
    const [row] = await tx
      .select({
        id: brands.id,
        name: brands.name,
        defaultLocale: brands.defaultLocale,
        timezone: brands.timezone,
        status: brands.status,
        settings: brands.settings,
      })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return row === undefined
      ? undefined
      : {
          id: row.id,
          name: row.name,
          defaultLocale: row.defaultLocale,
          timezone: row.timezone,
          status: row.status,
          contentPolicy: (row.settings as { contentPolicy?: unknown }).contentPolicy,
        };
  }

  async row(tx: DbTransaction, brandId: string): Promise<WidgetSettingsRow | undefined> {
    const [row] = await tx
      .select()
      .from(widgetSettings)
      .where(eq(widgetSettings.brandId, brandId))
      .limit(1);
    return row;
  }

  /** Writes the named columns, creating the row with defaults for the rest. */
  async upsert(
    tx: DbTransaction,
    brandId: string,
    values: Partial<Omit<WidgetSettingsRow, 'brandId' | 'updatedAt'>>,
  ): Promise<WidgetSettingsRow> {
    const now = new Date();
    const [row] = await tx
      .insert(widgetSettings)
      .values({ brandId, ...values, updatedAt: now })
      .onConflictDoUpdate({ target: widgetSettings.brandId, set: { ...values, updatedAt: now } })
      .returning();
    /* c8 ignore next 3 -- an upsert that returns nothing has failed and thrown. */
    if (row === undefined) {
      throw new Error('The widget settings upsert returned no row');
    }
    return row;
  }

  /** Sets `brands.settings.contentPolicy` alone, leaving every other key as it is. */
  async writeContentPolicy(tx: DbTransaction, brandId: string, policy: unknown): Promise<void> {
    await tx
      .update(brands)
      .set({
        settings: sql`jsonb_set(${brands.settings}, '{contentPolicy}', ${JSON.stringify(policy)}::jsonb)`,
      })
      .where(eq(brands.id, brandId));
  }

  async captcha(tx: DbTransaction, brandId: string): Promise<StoredCaptcha> {
    const rows = await tx
      .select({
        key: settings.key,
        value: settings.value,
        updatedAt: settings.updatedAt,
        updatedBy: settings.updatedBy,
      })
      .from(settings)
      .where(
        and(eq(settings.brandId, brandId), inArray(settings.key, Object.values(CAPTCHA_KEYS))),
      );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const secret = byKey.get(CAPTCHA_KEYS.secret);

    return {
      provider: byKey.get(CAPTCHA_KEYS.provider)?.value,
      siteKey: byKey.get(CAPTCHA_KEYS.siteKey)?.value,
      secret: secret?.value,
      secretSetAt: secret?.updatedAt ?? null,
      secretSetBy: secret?.updatedBy ?? null,
    };
  }

  /** One `settings` row of the brand, already encoded as `@helpdock/config` stores it. */
  async writeSetting(
    tx: DbTransaction,
    brandId: string,
    key: string,
    value: string,
    updatedBy: string,
  ): Promise<void> {
    const updatedAt = new Date();
    await tx
      .insert(settings)
      .values({ key, brandId, value, updatedBy, updatedAt })
      .onConflictDoUpdate({
        target: [settings.key, settings.brandId],
        set: { value, updatedBy, updatedAt },
      });
  }

  /** A person's name for "Saved 14 Sep by Lina Haddad"; null for a system actor. */
  async userName(tx: DbTransaction, userId: string | null): Promise<string | null> {
    if (userId === null || !/^[0-9a-f-]{36}$/i.test(userId)) {
      return null;
    }
    const [row] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.name ?? null;
  }
}

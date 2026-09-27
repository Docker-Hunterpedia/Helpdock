import {
  brandDomains,
  brands,
  customFieldDefs,
  type DbTransaction,
  departments,
  type StoredWebFormField,
  type StoredWebFormThankYou,
  type WebFormSettingsRow,
  webFormSettings,
} from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import { and, asc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { WebFormFieldDef } from './layout.js';

/** What the public page and the tab need of the brand itself. */
export interface WebFormBrand {
  readonly id: string;
  readonly name: string;
  readonly defaultLocale: Locale;
  readonly prefix: string;
  readonly active: boolean;
  readonly contentPolicy: unknown;
}

export interface WebFormSettingsWrite {
  readonly enabled: boolean;
  readonly departmentId: string | null;
  readonly captchaEnabled: boolean;
  readonly thankYou: StoredWebFormThankYou;
  readonly fields: StoredWebFormField[];
  readonly updatedBy: string;
}

/**
 * Reads and writes of M4-09, each in the caller's transaction. The brand
 * filter is the policy's (`app.brand_ids`); the explicit `brand_id` clauses
 * are there for the reader, not for isolation.
 */
export class WebFormRepository {
  async settings(tx: DbTransaction, brandId: string): Promise<WebFormSettingsRow | undefined> {
    const rows = await tx
      .select()
      .from(webFormSettings)
      .where(eq(webFormSettings.brandId, brandId))
      .limit(1);
    return rows[0];
  }

  async saveSettings(
    tx: DbTransaction,
    brandId: string,
    values: WebFormSettingsWrite,
  ): Promise<WebFormSettingsRow> {
    const rows = await tx
      .insert(webFormSettings)
      .values({ brandId, ...values })
      .onConflictDoUpdate({
        target: webFormSettings.brandId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an upsert that returns nothing would have thrown. */
    if (row === undefined) {
      throw new Error('The web form settings could not be saved');
    }
    return row;
  }

  /** The brand's ticket custom fields, in the order the custom field editor shows them. */
  async ticketFieldDefs(tx: DbTransaction): Promise<WebFormFieldDef[]> {
    return tx
      .select({
        key: customFieldDefs.key,
        label: customFieldDefs.label,
        labelAr: customFieldDefs.labelAr,
        type: customFieldDefs.type,
        options: customFieldDefs.options,
        webForm: customFieldDefs.webForm,
      })
      .from(customFieldDefs)
      .where(eq(customFieldDefs.target, 'ticket'))
      .orderBy(asc(customFieldDefs.sortOrder), asc(customFieldDefs.key));
  }

  /** "Show on web form" on exactly the ticket fields named, and off on every other. */
  async flagWebFormFields(tx: DbTransaction, keys: readonly string[]): Promise<void> {
    await tx
      .update(customFieldDefs)
      .set({ webForm: false })
      .where(
        keys.length === 0
          ? eq(customFieldDefs.target, 'ticket')
          : and(eq(customFieldDefs.target, 'ticket'), notInArray(customFieldDefs.key, [...keys])),
      );
    if (keys.length > 0) {
      await tx
        .update(customFieldDefs)
        .set({ webForm: true })
        .where(and(eq(customFieldDefs.target, 'ticket'), inArray(customFieldDefs.key, [...keys])));
    }
  }

  async departmentExists(tx: DbTransaction, departmentId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);
    return rows.length > 0;
  }

  /** The brand has no default department; the first in its own order stands in for one. */
  async firstDepartmentId(tx: DbTransaction, brandId: string): Promise<string | undefined> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.brandId, brandId))
      .orderBy(asc(departments.sortOrder), asc(departments.name))
      .limit(1);
    return rows[0]?.id;
  }

  async brand(tx: DbTransaction, brandId: string): Promise<WebFormBrand | undefined> {
    const rows = await tx
      .select({
        id: brands.id,
        name: brands.name,
        defaultLocale: brands.defaultLocale,
        prefix: brands.prefix,
        status: brands.status,
        deletedAt: brands.deletedAt,
        settings: brands.settings,
      })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      name: row.name,
      defaultLocale: row.defaultLocale,
      prefix: row.prefix,
      active: row.status === 'active' && row.deletedAt === null,
      contentPolicy: (row.settings as { contentPolicy?: unknown }).contentPolicy,
    };
  }

  /** The brand's verified help center host, where the form is served at `/contact`. */
  async helpCenterHost(tx: DbTransaction, brandId: string): Promise<string | undefined> {
    const rows = await tx
      .select({ domain: brandDomains.domain })
      .from(brandDomains)
      .where(
        and(
          eq(brandDomains.brandId, brandId),
          eq(brandDomains.kind, 'helpcenter'),
          isNotNull(brandDomains.verifiedAt),
        ),
      )
      .orderBy(asc(brandDomains.createdAt))
      .limit(1);
    return rows[0]?.domain;
  }
}

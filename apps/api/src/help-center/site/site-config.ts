import {
  brandDomains,
  brands,
  type DbTransaction,
  type HcMedia as HcMediaRow,
  hcMedia,
  hcSettings,
  widgetSettings,
} from '@helpdock/db';
import {
  HC_HOME_DEFAULTS,
  HC_THEME_DEFAULTS,
  type HcAccess,
  type HcHomeLayout,
  type HcLinks,
  type HcLocale,
  type HcMediaPurpose,
  type HcSiteImage,
  type HcTheme,
  hcHomeLayoutSchema,
  hcLinksSchema,
  hcMediaPath,
  hcThemeSchema,
} from '@helpdock/schemas';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';

/**
 * Everything about a brand the help center pages need besides its articles
 * (M5-03, M5-06): the brand, who may read it, the theme, logo and favicon,
 * the home layout, the links, the custom CSS, and the origins the brand's
 * widget may run on. One read per page render, in the brand's transaction.
 *
 * The jsonb columns are parsed with the defaults underneath, as
 * `widget/resolved-settings.ts` does for the widget: a stored value a later
 * release no longer accepts falls back to the default for that card rather
 * than taking the help center down.
 */

export interface SiteConfig {
  readonly brandId: string;
  readonly brandName: string;
  readonly defaultLocale: HcLocale;
  readonly timezone: string;
  readonly access: HcAccess;
  readonly theme: HcTheme;
  readonly logo: HcSiteImage | null;
  readonly favicon: HcSiteImage | null;
  readonly home: HcHomeLayout;
  readonly links: HcLinks;
  /** Sanitised when saved (`custom-css.ts`). */
  readonly customCss: string;
  readonly widgetOrigins: readonly string[];
  /** The brand's primary verified help center host, or null while it has none (ADR 0013's fallback). */
  readonly primaryDomain: string | null;
}

const EMPTY_LINKS: HcLinks = { header: [], footer: [] };

export const parsedOr = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  stored: unknown,
  fallback: T,
): T => {
  const parsed = schema.safeParse({ ...(fallback as object), ...(stored as object) });
  return parsed.success ? parsed.data : fallback;
};

export const toSiteImage = (row: HcMediaRow | undefined): HcSiteImage | null =>
  row?.status === 'ready'
    ? {
        mediaId: row.id,
        src: hcMediaPath(row.brandId, row.id),
        width: row.width,
        height: row.height,
      }
    : null;

/** The logo and favicon rows, by id. */
export const readSiteImages = async (
  tx: DbTransaction,
  ids: readonly (string | null)[],
): Promise<Map<string, HcMediaRow>> => {
  const wanted = ids.filter((id): id is string => id !== null);
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await tx.select().from(hcMedia).where(inArray(hcMedia.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
};

/** The brand's site configuration, or null when there is no such active brand. */
export const readSiteConfig = async (
  tx: DbTransaction,
  brandId: string,
): Promise<SiteConfig | null> => {
  const [brand] = await tx
    .select({
      name: brands.name,
      defaultLocale: brands.defaultLocale,
      timezone: brands.timezone,
      status: brands.status,
    })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (brand?.status !== 'active') {
    return null;
  }

  const [settings] = await tx
    .select()
    .from(hcSettings)
    .where(eq(hcSettings.brandId, brandId))
    .limit(1);
  const [widget] = await tx
    .select({ allowedOrigins: widgetSettings.allowedOrigins })
    .from(widgetSettings)
    .where(eq(widgetSettings.brandId, brandId))
    .limit(1);
  const [domain] = await tx
    .select({ domain: brandDomains.domain })
    .from(brandDomains)
    .where(
      and(
        eq(brandDomains.brandId, brandId),
        eq(brandDomains.kind, 'helpcenter'),
        isNotNull(brandDomains.verifiedAt),
      ),
    )
    .orderBy(desc(brandDomains.isPrimary), asc(brandDomains.createdAt))
    .limit(1);
  const images = await readSiteImages(tx, [
    settings?.logoMediaId ?? null,
    settings?.faviconMediaId ?? null,
  ]);

  return {
    brandId,
    brandName: brand.name,
    defaultLocale: brand.defaultLocale,
    timezone: brand.timezone,
    access: settings?.access ?? 'public',
    theme: parsedOr(hcThemeSchema, settings?.theme ?? {}, HC_THEME_DEFAULTS),
    logo: toSiteImage(images.get(settings?.logoMediaId ?? '')),
    favicon: toSiteImage(images.get(settings?.faviconMediaId ?? '')),
    home: parsedOr(hcHomeLayoutSchema, settings?.home ?? {}, HC_HOME_DEFAULTS),
    links: parsedOr(hcLinksSchema, settings?.links ?? {}, EMPTY_LINKS),
    customCss: settings?.customCss ?? '',
    widgetOrigins: widget?.allowedOrigins ?? [],
    primaryDomain: domain?.domain ?? null,
  };
};

/** A `ready` image of this brand uploaded for `purpose`, or undefined. */
export const readyImage = async (
  tx: DbTransaction,
  mediaId: string,
  purpose: HcMediaPurpose,
): Promise<HcMediaRow | undefined> => {
  const [row] = await tx
    .select()
    .from(hcMedia)
    .where(and(eq(hcMedia.id, mediaId), eq(hcMedia.purpose, purpose), eq(hcMedia.status, 'ready')))
    .limit(1);
  return row;
};

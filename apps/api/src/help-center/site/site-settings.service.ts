import { type DbTransaction, hcArticles, hcSettings } from '@helpdock/db';
import type {
  HcAppearance,
  HcAppearanceUpdateRequest,
  HcCustomCssResult,
  HcCustomCssUpdateRequest,
  HcHomeLayout,
  HcLinks,
  HcSite,
  HcSiteCard,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { writeHcAudit } from '../audit.js';
import { enqueueSiteChanged } from '../events.js';
import { HelpCenterFailure } from '../help-center-failure.js';
import type { HelpCenterContext } from '../structure.service.js';
import { sanitizeCustomCss } from './custom-css.js';
import { readSiteConfig, readyImage, type SiteConfig, toSiteImage } from './site-config.js';
import { helpCenterSiteUrl } from './site-url.js';
import { themeContrastError } from './theme.js';

/**
 * Help center › Settings below "Who can read it" (M5-06,
 * `Admin/HelpCenter-Settings`): Theme, Home page, Header and footer links,
 * Custom CSS. Each card saves on its own, is audited as `hc_settings.updated`
 * naming the card, and announces `help_center.site_changed` in the same
 * transaction, so the page cache drops the brand's pages (`cache-events.ts`).
 */
export class HelpCenterSiteSettingsService {
  readonly #appUrl: string;

  constructor(options: { appUrl: string }) {
    this.#appUrl = options.appUrl.replace(/\/$/, '');
  }

  async get({ tx, brandId }: HelpCenterContext): Promise<HcSite> {
    const config = await this.#config(tx, brandId);
    return {
      appearance: appearanceOf(config),
      home: config.home,
      links: config.links,
      customCss: config.customCss,
      url: this.siteUrl(config),
    };
  }

  /** Where the help center answers: its primary verified domain, or the install's fallback path. */
  siteUrl(config: Pick<SiteConfig, 'brandId' | 'primaryDomain'>): string {
    return helpCenterSiteUrl(this.#appUrl, config);
  }

  async updateAppearance(
    context: HelpCenterContext,
    request: HcAppearanceUpdateRequest,
  ): Promise<HcAppearance> {
    const { tx } = context;
    if (themeContrastError(request.theme)) {
      throw new HelpCenterFailure('low-contrast');
    }
    const logo =
      request.logoMediaId === null ? undefined : await readyImage(tx, request.logoMediaId, 'logo');
    const favicon =
      request.faviconMediaId === null
        ? undefined
        : await readyImage(tx, request.faviconMediaId, 'favicon');
    if (
      (request.logoMediaId !== null && logo === undefined) ||
      (request.faviconMediaId !== null && favicon === undefined)
    ) {
      throw new HelpCenterFailure('media-not-ready');
    }
    await this.#save(context, 'appearance', {
      theme: request.theme,
      logoMediaId: request.logoMediaId,
      faviconMediaId: request.faviconMediaId,
    });
    return { theme: request.theme, logo: toSiteImage(logo), favicon: toSiteImage(favicon) };
  }

  async updateHome(context: HelpCenterContext, request: HcHomeLayout): Promise<HcHomeLayout> {
    const { tx } = context;
    if (request.featuredArticleIds.length > 0) {
      const found = await tx
        .select({ id: hcArticles.id })
        .from(hcArticles)
        .where(inArray(hcArticles.id, [...request.featuredArticleIds]));
      if (found.length !== request.featuredArticleIds.length) {
        throw new HelpCenterFailure('unknown-article');
      }
    }
    await this.#save(context, 'home', { home: request });
    return request;
  }

  async updateLinks(context: HelpCenterContext, request: HcLinks): Promise<HcLinks> {
    await this.#save(context, 'links', { links: request });
    return request;
  }

  /**
   * Sanitises before storing (`custom-css.ts`) and answers what was removed,
   * so the card can list it; the stored CSS is only ever the sanitised text.
   */
  async updateCustomCss(
    context: HelpCenterContext,
    request: HcCustomCssUpdateRequest,
  ): Promise<HcCustomCssResult> {
    const sanitized = sanitizeCustomCss(request.css, { brandId: context.brandId });
    await this.#save(context, 'custom_css', { customCss: sanitized.css });
    return { css: sanitized.css, removed: [...sanitized.removed] };
  }

  async #config(tx: DbTransaction, brandId: string): Promise<SiteConfig> {
    const config = await readSiteConfig(tx, brandId);
    /* c8 ignore next 3 -- the permission guard has already resolved this brand as active. */
    if (config === null) {
      throw new NotFoundException('No such brand');
    }
    return config;
  }

  async #save(
    { tx, brandId, actorId }: HelpCenterContext,
    card: HcSiteCard,
    values: Partial<typeof hcSettings.$inferInsert>,
  ): Promise<void> {
    await tx
      .insert(hcSettings)
      .values({ brandId, updatedBy: actorId, ...values })
      .onConflictDoUpdate({ target: hcSettings.brandId, set: { updatedBy: actorId, ...values } });
    await writeHcAudit(tx, {
      brandId,
      actor: { type: 'staff', id: actorId },
      action: 'hc_settings.updated',
      targetType: 'hc_settings',
      targetId: brandId,
      meta: { card },
    });
    await enqueueSiteChanged(tx, brandId, card);
  }
}

const appearanceOf = (config: SiteConfig): HcAppearance => ({
  theme: config.theme,
  logo: config.logo,
  favicon: config.favicon,
});

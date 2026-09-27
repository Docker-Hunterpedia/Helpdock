import { auditLog, type DbTransaction, type WebFormSettingsRow } from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import {
  WEB_FORM_REFERENCE_PLACEHOLDER,
  type WebFormSettings,
  type WebFormSettingsUpdate,
  type WebFormThankYou,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { CaptchaKeysReader } from '../captcha/captcha-keys.js';
import { layoutFromUpdate, resolveFields, WebFormLayoutError } from './layout.js';
import type { WebFormRepository } from './web-form.repository.js';

export interface WebFormSettingsContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
}

/**
 * The catalog's thank-you message, the default until the Admin writes their
 * own. The placeholder is handed back to itself: it is the Admin's to see and
 * the page's to fill, not i18next's.
 */
export const defaultThankYou = (locale: Locale): string =>
  createI18n({ lng: locale }).getFixedT(locale, 'webform')('success.defaultThankYou', {
    ticket: { number: WEB_FORM_REFERENCE_PLACEHOLDER },
  });

/**
 * Where the brand's form is served: `/contact` on its verified help center
 * host (ARCHITECTURE §11), or `/contact/<brandId>` on the install's own
 * `APP_URL` until it has one — the same fallback ADR 0010 made for the rating
 * page, so a new install's form works before its DNS does.
 */
export const publicFormUrl = (
  appUrl: string,
  brandId: string,
  helpCenterHost: string | undefined,
): string =>
  helpCenterHost === undefined
    ? `${appUrl.replace(/\/+$/, '')}/contact/${brandId}`
    : `https://${helpCenterHost}/contact`;

/**
 * Channels › Web form (M4-09, artboard `AdminWebForm`): read and save one
 * brand's hosted form. `brand:manage`, like the other channel tabs an Admin
 * configures: the form decides which department strangers' tickets land in.
 *
 * Every save writes one `audit_log` row naming what changed.
 */
export class WebFormSettingsService {
  readonly #repository: WebFormRepository;
  readonly #captchaKeys: CaptchaKeysReader;
  readonly #appUrl: string;

  constructor(options: {
    readonly repository: WebFormRepository;
    readonly captchaKeys: CaptchaKeysReader;
    readonly appUrl: string;
  }) {
    this.#repository = options.repository;
    this.#captchaKeys = options.captchaKeys;
    this.#appUrl = options.appUrl;
  }

  async read(tx: DbTransaction, brandId: string): Promise<WebFormSettings> {
    const row = await this.#repository.settings(tx, brandId);
    return this.#view(tx, brandId, row);
  }

  async save(
    context: WebFormSettingsContext,
    update: WebFormSettingsUpdate,
  ): Promise<WebFormSettings> {
    const { tx, brandId } = context;
    if (
      update.departmentId !== null &&
      !(await this.#repository.departmentExists(tx, update.departmentId))
    ) {
      throw new NotFoundException('No such department in this brand');
    }

    const defs = await this.#repository.ticketFieldDefs(tx);
    let layout: ReturnType<typeof layoutFromUpdate>;
    try {
      layout = layoutFromUpdate(update.fields, defs);
    } catch (error) {
      if (error instanceof WebFormLayoutError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const before = await this.#repository.settings(tx, brandId);
    await this.#repository.flagWebFormFields(tx, layout.shownKeys);
    const row = await this.#repository.saveSettings(tx, brandId, {
      enabled: update.enabled,
      departmentId: update.departmentId,
      captchaEnabled: update.captchaEnabled,
      thankYou: thankYouToStore(update.thankYou),
      fields: layout.layout,
      updatedBy: context.actorId,
    });

    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: context.actorId,
      action: 'web_form.updated',
      targetType: 'brand',
      targetId: brandId,
      meta: {
        enabled: { from: before?.enabled ?? false, to: row.enabled },
        captchaEnabled: { from: before?.captchaEnabled ?? false, to: row.captchaEnabled },
        departmentId: { from: before?.departmentId ?? null, to: row.departmentId },
        shownCustomFields: layout.shownKeys,
      },
    });

    return this.#view(tx, brandId, row);
  }

  async #view(
    tx: DbTransaction,
    brandId: string,
    row: WebFormSettingsRow | undefined,
  ): Promise<WebFormSettings> {
    const defs = await this.#repository.ticketFieldDefs(tx);
    const keys = await this.#captchaKeys.forBrand(brandId);

    return {
      enabled: row?.enabled ?? false,
      publicUrl: publicFormUrl(
        this.#appUrl,
        brandId,
        await this.#repository.helpCenterHost(tx, brandId),
      ),
      departmentId: row?.departmentId ?? null,
      captcha: {
        enabled: row?.captchaEnabled ?? false,
        ready: keys !== null,
        provider: keys?.provider ?? null,
      },
      thankYou: {
        en: row?.thankYou.en ?? defaultThankYou('en'),
        ar: row?.thankYou.ar ?? defaultThankYou('ar'),
      },
      fields: resolveFields(row?.fields ?? [], defs),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }
}

/**
 * The catalog's default is not stored, so a brand that keeps it follows the
 * shipped wording as it improves — as the auto-reply templates do.
 */
const thankYouToStore = (thankYou: WebFormThankYou): { en?: string; ar?: string } => ({
  ...(thankYou.en === defaultThankYou('en') ? {} : { en: thankYou.en }),
  ...(thankYou.ar === defaultThankYou('ar') ? {} : { ar: thankYou.ar }),
});

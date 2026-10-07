import { brandDomains, customFieldDefs, type DbTransaction } from '@helpdock/db';
import {
  isWithinBusinessHours,
  nextOpening,
  type WidgetAvailability,
  type WidgetConfig,
  type WidgetLocale,
  type WidgetPrechatFieldView,
  type WidgetPresence,
} from '@helpdock/schemas';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { CaptchaKeysReader } from '../captcha/captcha-keys.js';
import type { HelpCenterFeedback } from '../help-center/ports.js';
import { readContentPolicy } from '../media/content-policy.js';
import type { BusinessHoursService } from '../sla/business-hours.service.js';
import { popularSummaries, WIDGET_POPULAR_ARTICLES } from './article-view.js';
import type { OnlineAgents } from './online-agents.js';
import type { ResolvedWidgetSettings } from './resolved-settings.js';
import type { WidgetGate, WidgetRequestFacts, WidgetScope } from './widget-gate.js';
import { greetingIn, widgetThemeOf } from './widget-theme.js';

/**
 * `GET /api/widget/:brandId/config` and `…/availability` (M4-06, M4-08).
 *
 * Nothing here is secret: it is what any page on an allowed origin needs for
 * the widget's first paint. The CAPTCHA appears only when the brand switched
 * it on *and* saved both keys, so a half-configured brand never shows a
 * challenge its api could not verify.
 *
 * Availability is the brand's calendar (M3-01's `BusinessHoursService`, the
 * brand's own hours and holidays) and M0-13's presence: whether anybody of
 * the brand is online right now, and who, when the brand shows agents.
 */

export class WidgetConfigService {
  readonly #gate: WidgetGate;
  readonly #businessHours: Pick<BusinessHoursService, 'calendarFor'>;
  readonly #online: Pick<OnlineAgents, 'presence' | 'presenceIn'>;
  readonly #captcha: CaptchaKeysReader;
  readonly #assetOrigin: string;
  readonly #popular: Pick<HelpCenterFeedback, 'popular'>;

  constructor(deps: {
    readonly gate: WidgetGate;
    readonly businessHours: Pick<BusinessHoursService, 'calendarFor'>;
    readonly online: Pick<OnlineAgents, 'presence' | 'presenceIn'>;
    readonly captcha: CaptchaKeysReader;
    /** `APP_URL`: where the api serves `widget.js` and the widget's fonts. */
    readonly assetOrigin: string;
    /** M5-10: the help center's popular list. */
    readonly popular: Pick<HelpCenterFeedback, 'popular'>;
  }) {
    this.#gate = deps.gate;
    this.#businessHours = deps.businessHours;
    this.#online = deps.online;
    this.#captcha = deps.captcha;
    this.#assetOrigin = deps.assetOrigin;
    this.#popular = deps.popular;
  }

  async config(
    brandId: string,
    facts: WidgetRequestFacts,
    requestedLocale?: WidgetLocale,
    now: Date = new Date(),
  ): Promise<WidgetConfig> {
    const config = await this.#settingsConfig(brandId, facts, requestedLocale, now);
    // M5-10. After the gate, in the help center's own transaction: the public
    // audience only, most viewed first.
    const popular = await this.#popular.popular({
      brandId,
      audience: 'public',
      locale: config.locale,
      limit: WIDGET_POPULAR_ARTICLES,
    });
    return { ...config, popularArticles: popularSummaries(popular, config.helpCenterUrl) };
  }

  #settingsConfig(
    brandId: string,
    facts: WidgetRequestFacts,
    requestedLocale: WidgetLocale | undefined,
    now: Date,
  ): Promise<WidgetConfig> {
    return this.#gate.brand(brandId, facts, async (scope) => {
      const { tx, brand, settings } = scope;
      const keys = settings.captchaEnabled ? await this.#captcha.forBrand(brandId, tx) : null;
      const locale = requestedLocale ?? brand.defaultLocale;
      const fields = await prechatFields(tx, settings, locale);

      return {
        brandId,
        brandName: brand.name,
        defaultLocale: brand.defaultLocale,
        locale,
        mode: settings.appearance.mode,
        appearance: settings.appearance,
        theme: widgetThemeOf(settings.appearance, this.#assetOrigin),
        greeting: greetingIn(settings.appearance, locale),
        prechat: {
          enabled: settings.conversation.prechatEnabled,
          fields,
        },
        contactForm: { fields: fields.filter((field) => field.kind === 'custom') },
        showAgentIdentity: settings.conversation.showAgentIdentity,
        whenUnavailable: settings.conversation.whenUnavailable,
        transcriptEnabled: settings.conversation.transcriptEnabled,
        contentPolicy: readContentPolicy(brand.contentPolicy),
        captcha: keys === null ? null : { provider: keys.provider, siteKey: keys.siteKey },
        signedIdentity: settings.signedIdentityEnabled,
        availability: await this.availabilityIn(scope, now),
        // Filled in by `config` once the gate has passed.
        popularArticles: [],
        helpCenterUrl: await helpCenterUrlOf(tx),
        // DESIGN §6.6: "removable per licence terms in the admin", which has
        // no switch yet, so every brand shows it.
        showPoweredBy: true,
      };
    });
  }

  availability(
    brandId: string,
    facts: WidgetRequestFacts,
    now: Date = new Date(),
  ): Promise<WidgetAvailability> {
    return this.#gate.brand(brandId, facts, (scope) => this.availabilityIn(scope, now));
  }

  async availabilityIn(scope: WidgetScope, now: Date): Promise<WidgetAvailability> {
    const calendar = await this.#businessHours.calendarFor(scope.brand.id, null, scope.tx);
    const open = isWithinBusinessHours(calendar, now);

    return {
      open,
      nextOpenAt: open ? null : (nextOpening(calendar, now)?.toISOString() ?? null),
      timezone: calendar.timezone,
      ...(await this.#online.presenceIn(scope.tx, scope.brand.id, scope.settings)),
    };
  }

  /** The `presence` frame: what a presence change, a new socket or a new stream is told. */
  presence(brandId: string): Promise<WidgetPresence> {
    return this.#online.presence(brandId);
  }
}

/** The form's fields as the widget renders them; a custom field that was deleted is left out. */
const prechatFields = async (
  tx: DbTransaction,
  settings: ResolvedWidgetSettings,
  locale: WidgetLocale,
): Promise<WidgetPrechatFieldView[]> => {
  const keys = settings.conversation.prechatFields.flatMap((field) =>
    field.kind === 'custom' ? [field.key] : [],
  );
  const defs =
    keys.length === 0
      ? []
      : await tx
          .select()
          .from(customFieldDefs)
          .where(and(eq(customFieldDefs.target, 'ticket'), inArray(customFieldDefs.key, keys)));
  const byKey = new Map(defs.map((def) => [def.key, def]));

  return settings.conversation.prechatFields.flatMap((field): WidgetPrechatFieldView[] => {
    if (field.kind !== 'custom') {
      return [
        {
          key: field.kind,
          kind: field.kind,
          required: field.required,
          label: null,
          type: field.kind === 'email' ? 'email' : 'text',
          options: [],
        },
      ];
    }
    const def = byKey.get(field.key);
    return def === undefined
      ? []
      : [
          {
            key: def.key,
            kind: 'custom',
            required: field.required,
            label: locale === 'ar' && def.labelAr ? def.labelAr : def.label,
            type: def.type,
            options: def.options,
          },
        ];
  });
};

/**
 * The brand's help center on its primary verified domain (M5-07), or null
 * while it has none. The request's transaction is scoped to the one brand, so
 * row-level security keeps every other brand's domains out of this read.
 */
export const helpCenterUrlOf = async (tx: DbTransaction): Promise<string | null> => {
  const [primary] = await tx
    .select({ domain: brandDomains.domain })
    .from(brandDomains)
    .where(
      and(
        eq(brandDomains.kind, 'helpcenter'),
        eq(brandDomains.isPrimary, true),
        isNotNull(brandDomains.verifiedAt),
      ),
    )
    .limit(1);
  return primary === undefined ? null : `https://${primary.domain}`;
};

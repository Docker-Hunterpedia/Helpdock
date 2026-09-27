import { customFieldDefs, type DbTransaction } from '@helpdock/db';
import {
  isWithinBusinessHours,
  nextOpening,
  type PresenceMap,
  type WidgetAvailability,
  type WidgetConfig,
  type WidgetPrechatFieldView,
} from '@helpdock/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import type { CaptchaKeysReader } from '../captcha/captcha-keys.js';
import { readContentPolicy } from '../media/content-policy.js';
import type { BusinessHoursService } from '../sla/business-hours.service.js';
import type { ResolvedWidgetSettings } from './resolved-settings.js';
import type { WidgetGate, WidgetRequestFacts, WidgetScope } from './widget-gate.js';

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
 * the brand is online right now.
 */

export interface PresenceReader {
  mapOf(brandId: string): Promise<PresenceMap>;
}

export class WidgetConfigService {
  readonly #gate: WidgetGate;
  readonly #businessHours: Pick<BusinessHoursService, 'calendarFor'>;
  readonly #presence: PresenceReader;
  readonly #captcha: CaptchaKeysReader;

  constructor(deps: {
    readonly gate: WidgetGate;
    readonly businessHours: Pick<BusinessHoursService, 'calendarFor'>;
    readonly presence: PresenceReader;
    readonly captcha: CaptchaKeysReader;
  }) {
    this.#gate = deps.gate;
    this.#businessHours = deps.businessHours;
    this.#presence = deps.presence;
    this.#captcha = deps.captcha;
  }

  config(
    brandId: string,
    facts: WidgetRequestFacts,
    now: Date = new Date(),
  ): Promise<WidgetConfig> {
    return this.#gate.brand(brandId, facts, async (scope) => {
      const { tx, brand, settings } = scope;
      const keys = settings.captchaEnabled ? await this.#captcha.forBrand(brandId, tx) : null;

      return {
        brandId,
        brandName: brand.name,
        defaultLocale: brand.defaultLocale,
        appearance: settings.appearance,
        prechat: {
          enabled: settings.conversation.prechatEnabled,
          fields: await prechatFields(tx, settings),
        },
        showAgentIdentity: settings.conversation.showAgentIdentity,
        whenUnavailable: settings.conversation.whenUnavailable,
        transcriptEnabled: settings.conversation.transcriptEnabled,
        contentPolicy: readContentPolicy(brand.contentPolicy),
        captcha: keys === null ? null : { provider: keys.provider, siteKey: keys.siteKey },
        signedIdentity: settings.signedIdentityEnabled,
        availability: await this.availabilityIn(scope, now),
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
      agentsOnline: await this.agentsOnline(scope.brand.id),
    };
  }

  async agentsOnline(brandId: string): Promise<boolean> {
    return Object.values(await this.#presence.mapOf(brandId)).includes('online');
  }
}

/** The form's fields as the widget renders them; a custom field that was deleted is left out. */
const prechatFields = async (
  tx: DbTransaction,
  settings: ResolvedWidgetSettings,
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
            label: { en: def.label, ar: def.labelAr },
            type: def.type,
            options: def.options,
          },
        ];
  });
};

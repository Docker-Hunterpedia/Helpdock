import type { WidgetSettingsRow } from '@helpdock/db';
import {
  type CaptchaDifficulty,
  type CaptchaProvider,
  captchaDifficultySchema,
  captchaProviderSchema,
  WIDGET_SETTINGS_DEFAULTS,
  type WidgetAppearance,
  type WidgetConversationSettings,
  widgetAppearanceSchema,
  widgetConversationSettingsSchema,
} from '@helpdock/schemas';
import type { StoredCaptcha } from './widget-settings.repository.js';

/**
 * A brand's widget as every request reads it: the stored row with the
 * defaults underneath, parsed. A stored value that no longer parses — a
 * field a later release tightened — falls back to the default for that card
 * rather than taking the widget down, as `readContentPolicy` does for M1-10.
 */
export interface ResolvedWidgetSettings {
  readonly appearance: WidgetAppearance;
  readonly conversation: WidgetConversationSettings;
  readonly allowedOrigins: readonly string[];
  readonly captchaEnabled: boolean;
  readonly signedIdentityEnabled: boolean;
  readonly signedIdentitySeesAllChannels: boolean;
  /** The encrypted envelope, or null when none was ever made. */
  readonly signingSecret: string | null;
  readonly signingSecretSetAt: Date | null;
  readonly signingSecretSetBy: string | null;
  readonly updatedAt: Date | null;
}

const parsedOr = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  stored: unknown,
  fallback: T,
): T => {
  const parsed = schema.safeParse({ ...(fallback as object), ...(stored as object) });
  return parsed.success ? parsed.data : fallback;
};

export const resolveWidgetSettings = (
  row: WidgetSettingsRow | undefined,
): ResolvedWidgetSettings => ({
  appearance: parsedOr(
    widgetAppearanceSchema,
    row?.appearance ?? {},
    widgetAppearanceSchema.parse(WIDGET_SETTINGS_DEFAULTS.appearance),
  ),
  conversation: parsedOr(
    widgetConversationSettingsSchema,
    row?.conversation ?? {},
    widgetConversationSettingsSchema.parse(WIDGET_SETTINGS_DEFAULTS.conversation),
  ),
  allowedOrigins: row?.allowedOrigins ?? [],
  captchaEnabled: row?.captchaEnabled ?? false,
  signedIdentityEnabled: row?.signedIdentityEnabled ?? false,
  signedIdentitySeesAllChannels: row?.signedIdentitySeesAllChannels ?? false,
  signingSecret: row?.signingSecret ?? null,
  signingSecretSetAt: row?.signingSecretSetAt ?? null,
  signingSecretSetBy: row?.signingSecretSetBy ?? null,
  updatedAt: row?.updatedAt ?? null,
});

/** A stored JSON string, or `undefined` for anything that is not one. */
const jsonString = (stored: string | undefined): string | undefined => {
  if (stored === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(stored);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

export interface ResolvedCaptcha {
  /**
   * The built-in `pow` for a brand that never saved one (D-51, ADR 0052).
   * A brand that saved its access card before 1.1 has a provider row, so it
   * keeps what it had; a row that no longer parses reads as 1.0's default,
   * Turnstile (ADR 0003).
   */
  readonly provider: CaptchaProvider;
  readonly difficulty: CaptchaDifficulty;
  readonly siteKey: string;
  /** The encrypted envelope, or null when none is saved. */
  readonly secret: string | null;
  readonly secretSetAt: Date | null;
  readonly secretSetBy: string | null;
}

export const resolveCaptcha = (stored: StoredCaptcha): ResolvedCaptcha => {
  const provider = captchaProviderSchema.safeParse(jsonString(stored.provider));
  const difficulty = captchaDifficultySchema.safeParse(jsonString(stored.difficulty));
  const secret = stored.secret === undefined || stored.secret === '' ? null : stored.secret;

  return {
    provider: provider.success
      ? provider.data
      : stored.provider === undefined
        ? 'pow'
        : 'turnstile',
    difficulty: difficulty.success ? difficulty.data : 'low',
    siteKey: jsonString(stored.siteKey) ?? '',
    secret,
    secretSetAt: secret === null ? null : stored.secretSetAt,
    secretSetBy: secret === null ? null : stored.secretSetBy,
  };
};

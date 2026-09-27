import { z } from 'zod';
import { customFieldKeySchema } from './custom-fields.js';
import { contentPolicySchema } from './media.js';

/**
 * A brand's chat widget, as the admin's Channels › Widget tab edits it (M4-03,
 * M4-06, M4-07, M4-08; artboard `AdminWidget`).
 *
 * The tab is split by who may change what (DOMAIN-RULES §1.2): a Team Leader
 * owns the widget's **appearance**, its **conversation** behaviour and the
 * **content policy**; an Admin also owns **where it may run** (allowed origins
 * and the bot check) and **signed identity**. The four update requests below
 * follow the cards, so a Team Leader's save can never carry an Admin's field.
 */

// --------------------------------------------------------------- appearance

/**
 * The four modes of REQUIREMENTS §4.6. `chat_articles` is not disabled: until
 * M5-10 it lists the brand's popular public articles, and M7 upgrades it with
 * AI search (canvas note).
 */
export const widgetModeSchema = z.enum(['chat', 'chat_articles', 'helpcenter', 'form']);
export type WidgetMode = z.infer<typeof widgetModeSchema>;

export const widgetColorSchemeSchema = z.enum(['light', 'dark', 'auto']);
export type WidgetColorScheme = z.infer<typeof widgetColorSchemeSchema>;

/**
 * Logical, like every layout rule in DESIGN.md: `end` is bottom right in
 * English and bottom left in Arabic, which is what the artboard's "Mirrored
 * for Arabic visitors" means.
 */
export const widgetPositionSchema = z.enum(['end', 'start']);
export type WidgetPosition = z.infer<typeof widgetPositionSchema>;

export const widgetLauncherSchema = z.enum(['icon', 'icon_text', 'text']);
export type WidgetLauncher = z.infer<typeof widgetLauncherSchema>;

/** `#RRGGBB`, upper-case: one spelling per colour, so a diff means a change. */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #0F766E')
  .transform((value) => value.toUpperCase());

/** The minimum contrast of white text on the accent (artboard: "Below 3 : 1 is refused"). */
export const WIDGET_ACCENT_MIN_CONTRAST = 3;

const channel = (value: number): number => {
  const unit = value / 255;
  return unit <= 0.039_28 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

/**
 * WCAG 2.1 contrast of white text on `hex`, the ratio the Accent field shows
 * beside the swatch. Here rather than in `@helpdock/ui` because the api
 * enforces it on save and does not depend on the design package.
 */
export const whiteContrastOn = (hex: string): number => {
  const value = Number.parseInt(hex.slice(1), 16);
  const luminance =
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff);

  return 1.05 / (luminance + 0.05);
};

export const WIDGET_GREETING_MAX = 280;

export const widgetAppearanceSchema = z.object({
  mode: widgetModeSchema,
  accent: hexColorSchema.refine(
    (hex) => whiteContrastOn(hex) >= WIDGET_ACCENT_MIN_CONTRAST,
    'white text on this accent is below 3:1',
  ),
  colorScheme: widgetColorSchemeSchema,
  position: widgetPositionSchema,
  launcher: widgetLauncherSchema,
  greetingEn: z.string().trim().max(WIDGET_GREETING_MAX),
  /** Empty falls back to the English greeting. */
  greetingAr: z.string().trim().max(WIDGET_GREETING_MAX),
});
export type WidgetAppearance = z.infer<typeof widgetAppearanceSchema>;

// ------------------------------------------------------------- conversation

/**
 * One field of the pre-chat form. `name` and `email` are built in; any other
 * key names a ticket custom field (Ticketing › Custom fields), whose answer is
 * saved on the ticket.
 */
export const prechatFieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('name'), required: z.boolean() }),
  z.object({ kind: z.literal('email'), required: z.boolean() }),
  z.object({ kind: z.literal('custom'), key: customFieldKeySchema, required: z.boolean() }),
]);
export type PrechatField = z.infer<typeof prechatFieldSchema>;

export const PRECHAT_FIELDS_MAX = 10;

export const widgetWhenUnavailableSchema = z.enum(['form', 'keep_chat']);
export type WidgetWhenUnavailable = z.infer<typeof widgetWhenUnavailableSchema>;

export const widgetConversationSettingsSchema = z.object({
  prechatEnabled: z.boolean(),
  prechatFields: z
    .array(prechatFieldSchema)
    .max(PRECHAT_FIELDS_MAX)
    .refine(
      (fields) =>
        new Set(fields.map((field) => (field.kind === 'custom' ? field.key : field.kind))).size ===
        fields.length,
      'a field may appear once',
    ),
  showAgentIdentity: z.boolean(),
  whenUnavailable: widgetWhenUnavailableSchema,
  transcriptEnabled: z.boolean(),
});
export type WidgetConversationSettings = z.infer<typeof widgetConversationSettingsSchema>;

// ------------------------------------------------------------------ origins

export const WIDGET_ORIGINS_MAX = 50;

/**
 * An origin and nothing else: `https://shop.example.com`, or `http://` for a
 * local development host. No path, query, fragment or credentials (the
 * artboard's hint), lower-cased, default port dropped — the exact string a
 * browser sends in `Origin`, so the check is an equality test.
 */
export const widgetOriginSchema = z
  .string()
  .trim()
  .max(255)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'must be an origin like https://example.com' });
      return z.NEVER;
    }
    const bare = `${url.protocol}//${url.host}`;
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      value.replace(/\/$/, '').toLowerCase() !== bare.toLowerCase()
    ) {
      context.addIssue({ code: 'custom', message: 'must be an origin like https://example.com' });
      return z.NEVER;
    }

    return url.origin;
  });

export const captchaProviderSchema = z.enum(['turnstile', 'hcaptcha']);
export type CaptchaProvider = z.infer<typeof captchaProviderSchema>;

/**
 * "Where the widget may run" (Admins only). The CAPTCHA keys are the brand's,
 * shared with the web form (ADR 0003), so they are edited here and read there.
 */
export const widgetAccessSchema = z.object({
  allowedOrigins: z.array(widgetOriginSchema).max(WIDGET_ORIGINS_MAX),
  captchaEnabled: z.boolean(),
  captchaProvider: captchaProviderSchema,
  captchaSiteKey: z.string().trim().max(255),
});
export type WidgetAccess = z.infer<typeof widgetAccessSchema>;

// ---------------------------------------------------------- signed identity

export const widgetSignedIdentitySchema = z.object({
  enabled: z.boolean(),
  seesAllChannels: z.boolean(),
});
export type WidgetSignedIdentity = z.infer<typeof widgetSignedIdentitySchema>;

/** Who last set a secret and when; never the secret (ADR 0003, AGENTS.md). */
export const secretStampSchema = z.object({
  setAt: z.iso.datetime(),
  setBy: z.string().nullable(),
});
export type SecretStamp = z.infer<typeof secretStampSchema>;

// ----------------------------------------------------------------- the view

/**
 * `GET /api/brands/:brandId/widget/settings`. A Team Leader gets `access` and
 * `signedIdentity` as null: the cards are hidden from them, and the values —
 * the origins included — are an Admin's to read.
 */
export const widgetSettingsSchema = z.object({
  brandId: z.uuid(),
  appearance: widgetAppearanceSchema,
  conversation: widgetConversationSettingsSchema,
  contentPolicy: contentPolicySchema,
  access: widgetAccessSchema.extend({ captchaSecret: secretStampSchema.nullable() }).nullable(),
  signedIdentity: widgetSignedIdentitySchema
    .extend({ secret: secretStampSchema.nullable() })
    .nullable(),
  updatedAt: z.iso.datetime(),
});
export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

/** `PUT …/widget/access`. A blank `captchaSecret` keeps the stored one. */
export const widgetAccessUpdateSchema = widgetAccessSchema.extend({
  captchaSecret: z.string().trim().max(255).optional(),
});
export type WidgetAccessUpdate = z.infer<typeof widgetAccessUpdateSchema>;

/**
 * `POST …/widget/signing-secret`: a new secret, returned this once. Replacing
 * it stops signatures made with the old one at once (artboard).
 */
export const widgetSigningSecretSchema = z.object({
  secret: z.string().min(32),
  stamp: secretStampSchema,
});
export type WidgetSigningSecret = z.infer<typeof widgetSigningSecretSchema>;

export const WIDGET_SETTINGS_DEFAULTS = {
  appearance: {
    mode: 'chat',
    accent: '#0F766E',
    colorScheme: 'auto',
    position: 'end',
    launcher: 'icon',
    greetingEn: 'Hi, how can we help today?',
    greetingAr: '',
  },
  conversation: {
    prechatEnabled: false,
    prechatFields: [
      { kind: 'name', required: false },
      { kind: 'email', required: false },
    ],
    showAgentIdentity: true,
    whenUnavailable: 'form',
    transcriptEnabled: false,
  },
} as const satisfies {
  readonly appearance: WidgetAppearance;
  readonly conversation: WidgetConversationSettings;
};

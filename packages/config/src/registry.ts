import {
  MAX_GOOGLE_ALLOWED_DOMAINS,
  MICROSOFT_CONSUMERS_TENANT_ID,
  MICROSOFT_TENANT_ID_PATTERN,
  WORKSPACE_DOMAIN_PATTERN,
} from '@helpdock/schemas';
import { z } from 'zod';
import { aiProvidersSchema } from './ai-providers.js';

/**
 * Where a value may be set. `install` settings have one value for the whole
 * deploy; `brand` settings have an install-wide default that a brand may
 * override once per-brand storage lands with the `settings` table (M0-03).
 */
export type SettingScope = 'install' | 'brand';

export interface SettingDefinition<
  TKey extends string = string,
  TSchema extends z.ZodType = z.ZodType,
> {
  /** Dotted identifier, also the primary key of the `settings` row. */
  readonly key: TKey;
  readonly schema: TSchema;
  readonly default: z.infer<TSchema>;
  /** Encrypted at rest and withheld from `getAll` unless secrets are asked for. */
  readonly secret: boolean;
  readonly scope: SettingScope;
  readonly description: string;
  /**
   * The environment variable that overrides and locks this setting, or null
   * for a setting no variable may pin: one whose readers do not consult the
   * pins yet, so a variable would be documented and do nothing.
   */
  readonly envKey: string | null;
}

/** `smtp.host` becomes `HD_SMTP_HOST`, `oauth.google.clientId` becomes `HD_OAUTH_GOOGLE_CLIENT_ID`. */
export const toEnvKey = (key: string): string =>
  `HD_${key
    .replaceAll('.', '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()}`;

const defineSetting = <TKey extends string, TSchema extends z.ZodType>(definition: {
  readonly key: TKey;
  readonly schema: TSchema;
  readonly default: z.infer<TSchema>;
  readonly secret: boolean;
  readonly scope: SettingScope;
  readonly description: string;
  readonly envKey?: string | null;
}): SettingDefinition<TKey, TSchema> => ({
  ...definition,
  envKey: definition.envKey === undefined ? toEnvKey(definition.key) : definition.envKey,
});

const PORT = z.int().min(1).max(65_535);
const TEXT = z.string();
/** pgvector indexes cover at most 2,000 dimensions (ADR 0005); 0 means "not configured yet". */
const EMBEDDING_DIMS = z.int().min(0).max(2_000);
/** A pacing interval: at least a minute, at most a day. */
const MINUTES = z.int().min(1).max(1_440);
/** A pacing cap: at least one email, so a cap can never stop email altogether. */
const COUNT = z.int().min(1).max(1_000);

/**
 * Every non-bootstrap setting M0 needs. Later milestones append to this list;
 * nothing else in the codebase may invent a settings key.
 */
export const SETTING_DEFINITIONS = [
  defineSetting({
    key: 'smtp.host',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'brand',
    description:
      'SMTP server used to send mail. Empty until the wizard or the System page sets it.',
  }),
  defineSetting({
    key: 'smtp.port',
    schema: PORT,
    default: 587,
    secret: false,
    scope: 'brand',
    description: 'SMTP port. 587 for STARTTLS, 465 for implicit TLS.',
  }),
  defineSetting({
    key: 'smtp.tls',
    // The same three values as `smtpTlsModeSchema` in `@helpdock/schemas`,
    // spelled again because `packages/config` sits below that package. A unit
    // test in `apps/api/src/install`, which imports both, holds them together.
    schema: z.enum(['starttls', 'tls', 'none']),
    default: 'starttls',
    secret: false,
    scope: 'brand',
    description:
      'How the SMTP connection is protected: starttls upgrades an open connection (587), tls is implicit TLS (465), none is an unencrypted relay.',
  }),
  defineSetting({
    key: 'smtp.user',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'brand',
    description: 'SMTP username. Empty for a relay that does not authenticate.',
  }),
  defineSetting({
    key: 'smtp.password',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'brand',
    description: 'SMTP password.',
  }),
  defineSetting({
    key: 'smtp.from',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'brand',
    description: 'Envelope and header From address. The display name is smtp.fromName.',
  }),
  defineSetting({
    key: 'smtp.fromName',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'brand',
    description: 'Display name shown beside the From address, for example the brand name.',
  }),
  defineSetting({
    key: 'oauth.google.clientId',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description: 'Google OAuth client id for staff sign-in. Empty disables the button.',
  }),
  defineSetting({
    key: 'oauth.google.clientSecret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description: 'Google OAuth client secret.',
  }),
  defineSetting({
    key: 'oauth.google.allowedDomains',
    // Lower-case host names, as Google writes the `hd` claim.
    schema: z.array(z.string().regex(WORKSPACE_DOMAIN_PATTERN)).max(MAX_GOOGLE_ALLOWED_DOMAINS),
    default: [],
    secret: false,
    scope: 'install',
    description:
      'Google Workspace domains (the hd claim) whose accounts may use Google sign-in, as a JSON array. Empty allows any address Google vouches for; a list also refuses @gmail.com (ADR 0051).',
  }),
  defineSetting({
    key: 'oauth.microsoft.tenantId',
    // One Entra tenant per install: a GUID, or empty while the provider is off.
    schema: z
      .string()
      // An operator may paste the GUID as Entra shows it, in either case.
      .toLowerCase()
      .regex(MICROSOFT_TENANT_ID_PATTERN)
      .refine((id) => id !== MICROSOFT_CONSUMERS_TENANT_ID)
      .or(z.literal('')),
    default: '',
    secret: false,
    scope: 'install',
    description:
      'Microsoft Entra directory (tenant) id whose work accounts may use Microsoft sign-in, as a GUID. common, organizations and the personal-accounts tenant are refused (ADR 0051).',
  }),
  defineSetting({
    key: 'oauth.microsoft.allowConsumers',
    schema: z.boolean(),
    default: false,
    secret: false,
    scope: 'install',
    description:
      'Also let personal Microsoft accounts (Outlook.com, Hotmail) sign in, through the consumers tenant. They can only be connected from the security page, never linked by address. Off unless you need it (ADR 0051).',
  }),
  defineSetting({
    key: 'oauth.microsoft.clientId',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description:
      'Microsoft Entra application (client) id for staff sign-in. Empty, or an empty tenant id, disables the button.',
  }),
  defineSetting({
    key: 'oauth.microsoft.clientSecret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description: 'Microsoft Entra client secret value.',
  }),
  defineSetting({
    key: 'oauth.github.clientId',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description: 'GitHub OAuth client id for staff sign-in. Empty disables the button.',
  }),
  defineSetting({
    key: 'oauth.github.clientSecret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description: 'GitHub OAuth client secret.',
  }),
  defineSetting({
    key: 'sso.enforced',
    schema: z.boolean(),
    default: false,
    secret: false,
    scope: 'install',
    description: 'Require staff SSO except designated break-glass install admins.',
  }),
  defineSetting({
    key: 'sso.breakGlassUserIds',
    schema: z.array(z.uuid()).max(3),
    default: [],
    secret: false,
    scope: 'install',
    description:
      'Install admins who retain password and (authenticator code or passkey) sign-in during SSO enforcement.',
  }),
  defineSetting({
    key: 'sso.spPrivateKey',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description: 'Install SAML signing private key, generated atomically on first use.',
  }),
  defineSetting({
    key: 'sso.spCertificate',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description: 'Public certificate matching the install SAML signing key.',
  }),
  defineSetting({
    key: 'auth.require2fa',
    schema: z.boolean(),
    default: false,
    secret: false,
    scope: 'install',
    description: 'Require TOTP for every staff account on this install.',
  }),
  defineSetting({
    key: 'auth.jwtSigningKey',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description:
      'ES256 key pair the api signs access tokens with, as JSON. Generated at first boot and shared by every replica; never set by hand. Rotating it signs every session out (ARCHITECTURE §7).',
  }),
  defineSetting({
    key: 'auth.magicLinkTtlMinutes',
    schema: z.int().min(1).max(60),
    default: 10,
    secret: false,
    scope: 'install',
    description: 'Lifetime of a single-use magic link, in minutes (DOMAIN-RULES §4.6).',
  }),
  defineSetting({
    key: 'auth.webauthn.rpId',
    // A lower-case host name as `new URL(APP_URL).hostname` spells it, or empty
    // while no passkey ceremony has run yet.
    schema: z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*)?$/),
    default: '',
    secret: false,
    scope: 'install',
    description:
      'Passkey relying party id: the host of APP_URL, written by the first successful passkey registration; not set by hand. If APP_URL later names another host, passkey ceremonies are refused with passkeys-rp-changed and every other sign-in method keeps working (ADR 0050).',
  }),
  defineSetting({
    key: 'roles.viewerEnabled',
    schema: z.boolean(),
    default: true,
    secret: false,
    scope: 'install',
    description: 'Whether the optional read-only Viewer role can be assigned (REQUIREMENTS §2).',
  }),
  defineSetting({
    key: 'contacts.defaultCallingCode',
    // Digits, with or without the plus. Empty means "no fallback": a phone
    // number that is not already in international form is refused rather than
    // guessed at (ADR 0008).
    schema: z.string().regex(/^\+?\d{0,4}$/),
    default: '',
    secret: false,
    scope: 'brand',
    description:
      'Country calling code prefixed to phone numbers typed without one, for example 49. Empty refuses them instead (ADR 0008).',
  }),
  defineSetting({
    key: 'captcha.provider',
    schema: z.enum(['pow', 'turnstile', 'hcaptcha', 'none']),
    default: 'none',
    secret: false,
    scope: 'brand',
    description:
      'CAPTCHA for visitor-facing forms. Off by default; a brand that turns it on starts with the built-in proof-of-work check, `pow`, which sends nothing to a third party (ADR 0052). Turnstile is the stronger bot detection (ADR 0003).',
  }),
  defineSetting({
    key: 'captcha.difficulty',
    schema: z.enum(['low', 'medium']),
    default: 'low',
    secret: false,
    scope: 'brand',
    description:
      'How much work the built-in `pow` check asks of a visitor: `low` is about half a second on a mid-range phone, `medium` about two seconds (ADR 0052). Set on Channels › Widget.',
    // The widget and the web form read the brand's `captcha.*` rows directly,
    // so an `HD_` pin would not reach them (M18 plan, open item 8).
    envKey: null,
  }),
  defineSetting({
    key: 'captcha.siteKey',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'brand',
    description: 'Public CAPTCHA site key, rendered by the widget and the web form.',
  }),
  defineSetting({
    key: 'captcha.secret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'brand',
    description: 'CAPTCHA secret used server-side to verify a challenge token.',
  }),
  defineSetting({
    key: 'push.vapidPublicKey',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description: 'VAPID public key served to the admin app as applicationServerKey (ADR 0002).',
  }),
  defineSetting({
    key: 'push.vapidPrivateKey',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description: 'VAPID private key used to sign web push messages.',
  }),
  defineSetting({
    key: 'embedding.provider',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description: 'Embedding provider for knowledge retrieval. One per install (ADR 0005).',
  }),
  defineSetting({
    key: 'embedding.model',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description:
      'Embedding model. Changing it re-embeds eligible chunks (ADR 0005); imported article languages stay deferred until staff publication (ADR 0027).',
  }),
  defineSetting({
    key: 'embedding.dims',
    schema: EMBEDDING_DIMS,
    default: 0,
    secret: false,
    scope: 'install',
    description:
      'Dimension of the embedding column, derived from the model when it is first saved.',
  }),
  defineSetting({
    key: 'embedding.baseUrl',
    schema: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]),
    default: '',
    secret: false,
    scope: 'install',
    description:
      'OpenAI-compatible embeddings endpoint, for example https://api.openai.com/v1 or http://ollama:11434/v1.',
  }),
  defineSetting({
    key: 'embedding.apiKey',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description:
      'API key for the embeddings endpoint. Empty for a local server that asks for none.',
  }),
  defineSetting({
    key: 'embedding.pricePerMillionTokens',
    schema: z.number().min(0).max(1_000),
    default: 0,
    secret: false,
    scope: 'install',
    description:
      'US dollars per million input tokens of the embedding model, for the AI cost log. 0 for a local model.',
  }),
  defineSetting({
    key: 'ai.providers',
    schema: aiProvidersSchema,
    default: [],
    secret: true,
    scope: 'install',
    description:
      'Model providers and their credentials (API key or OAuth tokens), as a JSON array. Never returned to the client (ADR 0018).',
  }),
  defineSetting({
    key: 'ai.defaultProvider',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description: 'Id of the provider every brand uses unless it overrides it.',
  }),
  defineSetting({
    key: 'ai.defaultModel',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description: 'Model id, of the default provider, every brand uses unless it overrides it.',
  }),
  defineSetting({
    key: 'knowledge.notion.clientId',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description:
      'OAuth client id of the install’s public Notion integration, for brands connecting Notion (M7-03).',
  }),
  defineSetting({
    key: 'knowledge.notion.clientSecret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description: 'OAuth client secret of the Notion integration.',
  }),
  defineSetting({
    key: 'knowledge.google.clientId',
    schema: TEXT,
    default: '',
    secret: false,
    scope: 'install',
    description:
      'OAuth client id of the install’s Google Cloud app, for brands connecting Google Drive (M7-03).',
  }),
  defineSetting({
    key: 'knowledge.google.clientSecret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description: 'OAuth client secret of the Google Cloud app.',
  }),
  defineSetting({
    key: 'transcription.endpoint',
    schema: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]),
    default: '',
    secret: false,
    scope: 'install',
    description:
      'Whisper-compatible transcription endpoint for voice notes, for example https://api.openai.com/v1/audio/transcriptions. Empty turns transcription off.',
  }),
  defineSetting({
    key: 'transcription.model',
    schema: TEXT,
    default: 'whisper-1',
    secret: false,
    scope: 'install',
    description: 'Model the transcription endpoint is asked for.',
  }),
  defineSetting({
    key: 'transcription.apiKey',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description:
      'API key for the transcription endpoint. Empty for a local server that asks for none.',
  }),
  // M10-01 (ADR 0025). An install has one Meta developer app, and a Meta app has
  // one callback URL and one signing secret, so these are install settings;
  // each connected number, Page or account holds its own token in
  // `meta_accounts`.
  defineSetting({
    key: 'meta.appId',
    // Digits only, as Meta issues them; empty until the operator saves one.
    schema: z.string().regex(/^\d{0,25}$/),
    default: '',
    secret: false,
    scope: 'install',
    description:
      'Id of the install’s Meta developer app, from the app dashboard. Messenger echoes of Helpdock’s own replies are recognised by it (M10-04).',
  }),
  defineSetting({
    key: 'meta.appSecret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description:
      'App secret of the Meta developer app. Every webhook from Meta is signed with it (X-Hub-Signature-256) and refused without a match.',
  }),
  defineSetting({
    key: 'meta.instagramAppSecret',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description:
      'Instagram app secret, from the Instagram product of the Meta app. Empty when Instagram webhooks are signed with the app secret; a webhook is accepted when either matches.',
  }),
  defineSetting({
    key: 'meta.webhookVerifyToken',
    schema: TEXT,
    default: '',
    secret: true,
    scope: 'install',
    description:
      'The token Meta sends with its callback-URL handshake. Generated on first read when empty; paste the same value into the Meta dashboard.',
  }),
  // M14-10 (ADR 0037, DOMAIN-RULES §20). How Right away notification email is
  // paced. Install settings: a self-hosted desk sets its own, and every person
  // in every brand is paced the same way.
  defineSetting({
    key: 'notify.email.firstWaitMinutes',
    schema: MINUTES,
    default: 2,
    secret: false,
    scope: 'install',
    description:
      'Right away email: minutes from the first notification to its email, gathering what arrives meanwhile.',
  }),
  defineSetting({
    key: 'notify.email.backoffMinutes',
    schema: z.array(MINUTES).min(1).max(10),
    default: [10, 20, 40, 60],
    secret: false,
    scope: 'install',
    description:
      'Right away email: minutes between emails while more keeps arriving, one step per email; the last step repeats. A JSON array.',
  }),
  defineSetting({
    key: 'notify.email.quietResetMinutes',
    schema: MINUTES,
    default: 120,
    secret: false,
    scope: 'install',
    description:
      'Right away email: after this many minutes with nothing new, the next email waits the first wait again.',
  }),
  defineSetting({
    key: 'notify.email.urgentIntervalMinutes',
    schema: MINUTES,
    default: 5,
    secret: false,
    scope: 'install',
    description:
      'Right away email: a mention, SLA breach or escalation may cut the wait, but no more often than every this many minutes.',
  }),
  defineSetting({
    key: 'notify.email.urgentPerDay',
    schema: COUNT,
    default: 8,
    secret: false,
    scope: 'install',
    description: 'Right away email: how many times a day an urgent notification may cut the wait.',
  }),
  defineSetting({
    key: 'notify.email.perHour',
    schema: COUNT,
    default: 6,
    secret: false,
    scope: 'install',
    description:
      'Most notification emails one person gets from one brand in an hour, digests included.',
  }),
  defineSetting({
    key: 'notify.email.perDay',
    schema: COUNT,
    default: 40,
    secret: false,
    scope: 'install',
    description:
      'Most notification emails one person gets from one brand in a day, digests included.',
  }),
] as const;

type Definition = (typeof SETTING_DEFINITIONS)[number];

export type SettingKey = Definition['key'];

/** The value type behind every key, so `get('smtp.port')` is a `number`. */
export type SettingValues = {
  readonly [D in Definition as D['key']]: z.infer<D['schema']>;
};

export type SettingValue<TKey extends SettingKey> = SettingValues[TKey];

export const SETTING_KEYS: readonly SettingKey[] = SETTING_DEFINITIONS.map(
  (definition) => definition.key,
);

// Building the two lookups by hand keeps the key union: `Object.fromEntries`
// would widen it to a string index signature. The accumulators start empty and
// the loop below fills every key, which the test suite checks.
const definitionsByKey = {} as Record<SettingKey, SettingDefinition>;
const schemasByKey = {} as Record<SettingKey, z.ZodType>;

for (const definition of SETTING_DEFINITIONS) {
  definitionsByKey[definition.key] = definition;
  schemasByKey[definition.key] = definition.schema;
}

export const settingDefinitions: Readonly<Record<SettingKey, SettingDefinition>> =
  Object.freeze(definitionsByKey);

/** The Zod schema per key, for consumers that validate a value without the service. */
export const settingsSchema = Object.freeze(schemasByKey) as {
  readonly [D in Definition as D['key']]: D['schema'];
};

export const isSettingKey = (value: string): value is SettingKey =>
  Object.hasOwn(settingDefinitions, value);

import { z } from 'zod';

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
  /** The environment variable that overrides and locks this setting. */
  readonly envKey: string;
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
  readonly envKey?: string;
}): SettingDefinition<TKey, TSchema> => ({
  ...definition,
  envKey: definition.envKey ?? toEnvKey(definition.key),
});

const PORT = z.int().min(1).max(65_535);
const TEXT = z.string();
/** pgvector indexes cover at most 2,000 dimensions (ADR 0005); 0 means "not configured yet". */
const EMBEDDING_DIMS = z.int().min(0).max(2_000);

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
    description: 'SMTP server used to send mail. Empty until the first-run wizard sets it.',
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
    description: 'Envelope and header From address, optionally with a display name.',
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
    key: 'auth.require2fa',
    schema: z.boolean(),
    default: false,
    secret: false,
    scope: 'install',
    description: 'Require TOTP for every staff account on this install.',
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
    key: 'roles.viewerEnabled',
    schema: z.boolean(),
    default: true,
    secret: false,
    scope: 'install',
    description: 'Whether the optional read-only Viewer role can be assigned (REQUIREMENTS §2).',
  }),
  defineSetting({
    key: 'captcha.provider',
    schema: z.enum(['turnstile', 'hcaptcha', 'none']),
    default: 'none',
    secret: false,
    scope: 'brand',
    description:
      'CAPTCHA for visitor-facing forms. Off by default; Turnstile is the recommended provider (ADR 0003).',
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
    description: 'Embedding model. Changing it re-embeds every chunk (ADR 0005).',
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

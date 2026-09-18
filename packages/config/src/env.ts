import { isIPv4, isIPv6 } from 'node:net';
import { z } from 'zod';

// AES-256 needs a 32-byte key. `APP_MASTER_KEY` carries it as standard base64.
const MASTER_KEY_BYTES = 32;

const MAX_PORT = 65_535;
const DEFAULT_PORT = 3000;
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const NO_CIDRS: readonly string[] = [];

/**
 * The process environment as Node hands it over: string values, or absent. An
 * empty or whitespace-only value counts as absent, so a key left blank in
 * `.env.example` behaves like one that was never set.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Decodes a master key, or returns `undefined` unless it is 32 bytes of standard base64. */
export const decodeMasterKey = (value: string): Buffer | undefined => {
  const decoded = Buffer.from(value, 'base64');
  // `Buffer.from` silently drops anything that is not base64, so round-tripping
  // is the only way to tell a real key from a typo of the right length.
  return decoded.byteLength === MASTER_KEY_BYTES && decoded.toString('base64') === value
    ? decoded
    : undefined;
};

const masterKeySchema = () => z.string().refine((value) => decodeMasterKey(value) !== undefined);

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const urlSchema = (...schemes: readonly string[]) =>
  z.string().refine((value) => {
    const url = parseUrl(value);
    return url !== undefined && schemes.includes(url.protocol);
  });

const isCidr = (entry: string): boolean => {
  const separator = entry.lastIndexOf('/');
  if (separator < 1) {
    return false;
  }

  const address = entry.slice(0, separator);
  const prefix = entry.slice(separator + 1);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(prefix)) {
    return false;
  }

  const bits = Number(prefix);
  if (isIPv4(address)) {
    return bits <= IPV4_BITS;
  }
  return isIPv6(address) && bits <= IPV6_BITS;
};

const cidrListSchema = () =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .refine((entries) => entries.every(isCidr))
    // The annotation is what makes the field `readonly string[]` on `Env`;
    // `loadEnv` is where the array is actually frozen.
    .transform((entries): readonly string[] => entries);

/**
 * The `.env` bootstrap layer of ARCHITECTURE §4: everything the process needs
 * before it can read the `settings` table. Every field carries the description
 * used both in `.env.example` and in the error {@link loadEnv} throws, so the
 * two can never drift apart.
 */
export const envSchema = z.object({
  APP_URL: urlSchema('http:', 'https:').describe(
    'must be the public http(s) URL of this install, for example https://support.example.com',
  ),
  APP_ROLE: z.enum(['api', 'worker']).describe('must be "api" or "worker"'),
  APP_MASTER_KEY: masterKeySchema().describe(
    'must be 32 bytes of standard base64 (openssl rand -base64 32)',
  ),
  APP_MASTER_KEY_PREVIOUS: masterKeySchema()
    .optional()
    .describe(
      'optional; the key being rotated away from, 32 bytes of standard base64 (DOMAIN-RULES §10)',
    ),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .describe('must be "development", "test" or "production"'),
  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PORT)
    .default(DEFAULT_PORT)
    .describe(`optional; must be a port number between 1 and ${MAX_PORT}, default ${DEFAULT_PORT}`),
  DATABASE_URL: urlSchema('postgres:', 'postgresql:').describe(
    'must be a postgres:// URL for the runtime role',
  ),
  DATABASE_MIGRATION_URL: urlSchema('postgres:', 'postgresql:').describe(
    'must be a postgres:// URL for the migration owner role',
  ),
  REDIS_URL: urlSchema('redis:', 'rediss:').describe('must be a redis:// or rediss:// URL'),
  S3_ENDPOINT: urlSchema('http:', 'https:').describe('must be the http(s) URL of the S3 endpoint'),
  S3_REGION: z.string().min(1).describe('must be the S3 region, for example us-east-1'),
  S3_BUCKET: z.string().min(1).describe('must be the bucket that holds attachments and images'),
  S3_ACCESS_KEY_ID: z.string().min(1).describe('must be the S3 access key id'),
  S3_SECRET_ACCESS_KEY: z.string().min(1).describe('must be the S3 secret access key'),
  OUTBOUND_ALLOW_CIDRS: cidrListSchema()
    .default(NO_CIDRS)
    .describe(
      'optional; comma-separated CIDRs the SSRF-safe client may reach, for example 10.0.0.0/8',
    ),
});

export type Env = Readonly<z.infer<typeof envSchema>>;
export type EnvKey = keyof z.infer<typeof envSchema>;

/** Every bootstrap key, in the order `.env.example` documents them. */
export const ENV_KEYS = Object.keys(envSchema.shape) as readonly EnvKey[];

const describeKey = (key: EnvKey): string => envSchema.shape[key].description ?? '';

/**
 * Thrown when `.env` is incomplete or wrong. The message names every offending
 * key and what it expects, and never the value it was given: bootstrap keys
 * include the master key and the S3 credentials.
 */
export class EnvValidationError extends Error {
  readonly keys: readonly EnvKey[];

  constructor(keys: readonly EnvKey[]) {
    const details = keys.map((key) => `  - ${key}: ${describeKey(key)}`).join('\n');
    super(`Invalid environment configuration:\n${details}`);
    this.name = 'EnvValidationError';
    this.keys = keys;
  }
}

const normalize = (source: EnvSource): Record<string, string> => {
  const normalized: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = source[key]?.trim();
    if (value !== undefined && value !== '') {
      normalized[key] = value;
    }
  }
  return normalized;
};

/**
 * Validates the bootstrap environment and returns it frozen and typed. Throws a
 * single {@link EnvValidationError} listing every invalid key, so an operator
 * fixes `.env` in one pass instead of one restart per mistake.
 */
export const loadEnv = (source: EnvSource = process.env): Env => {
  const result = envSchema.safeParse(normalize(source));

  if (!result.success) {
    // Every issue comes from a top-level key: `normalize` only ever produces
    // the keys of the schema, so no nested path can appear here.
    const keys = result.error.issues.map((issue) => issue.path[0] as EnvKey);
    throw new EnvValidationError([...new Set(keys)]);
  }

  for (const value of Object.values(result.data)) {
    if (Array.isArray(value)) {
      Object.freeze(value);
    }
  }

  return Object.freeze(result.data);
};

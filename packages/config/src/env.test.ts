import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPOSE_SECTION_MARKER,
  decodeMasterKey,
  ENV_KEYS,
  type EnvSource,
  EnvValidationError,
  envSchema,
  loadEnv,
} from './env.js';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const completeEnv: Record<string, string> = {
  APP_URL: 'https://support.example.com',
  APP_ROLE: 'api',
  APP_MASTER_KEY: MASTER_KEY,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://runtime:pw@postgres:5432/helpdock',
  DATABASE_MIGRATION_URL: 'postgresql://owner:pw@postgres:5432/helpdock',
  REDIS_URL: 'redis://redis:6379',
  S3_ENDPOINT: 'http://minio:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'helpdock',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const envWith = (overrides: EnvSource): EnvSource => ({ ...completeEnv, ...overrides });

const expectInvalidKeys = (source: EnvSource, keys: readonly string[]): EnvValidationError => {
  try {
    loadEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    const failure = error as EnvValidationError;
    expect([...failure.keys].sort()).toEqual([...keys].sort());
    return failure;
  }

  throw new Error(`expected loadEnv to reject ${keys.join(', ')}`);
};

describe('loadEnv', () => {
  it('applies the documented defaults for the optional keys', () => {
    const env = loadEnv(completeEnv);

    expect(env.PORT).toBe(3000);
    expect(env.OUTBOUND_ALLOW_CIDRS).toEqual([]);
    expect(env.APP_MASTER_KEY_PREVIOUS).toBeUndefined();
    expect(env.TRUST_PROXY).toBe(false);
    // Where docker/Dockerfile copies apps/admin/dist, so an image needs no key.
    expect(env.ADMIN_DIST_DIR).toBe('/app/admin');
  });

  it('reads TRUST_PROXY as a boolean, in the spellings an operator reaches for', () => {
    for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
      expect(loadEnv(envWith({ TRUST_PROXY: value })).TRUST_PROXY, value).toBe(true);
    }
    for (const value of ['false', '0', 'no', 'off']) {
      expect(loadEnv(envWith({ TRUST_PROXY: value })).TRUST_PROXY, value).toBe(false);
    }
  });

  it('refuses a TRUST_PROXY it would have to guess at, rather than defaulting to trust', () => {
    expectInvalidKeys(envWith({ TRUST_PROXY: 'maybe' }), ['TRUST_PROXY']);
  });

  it('defaults the log level to info and takes any level pino knows', () => {
    expect(loadEnv(completeEnv).LOG_LEVEL).toBe('info');

    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
      expect(loadEnv(envWith({ LOG_LEVEL: level })).LOG_LEVEL, level).toBe(level);
    }
  });

  it('refuses a log level that is not one, rather than logging nothing by accident', () => {
    expectInvalidKeys(envWith({ LOG_LEVEL: 'verbose' }), ['LOG_LEVEL']);
    expectInvalidKeys(envWith({ LOG_LEVEL: 'INFO' }), ['LOG_LEVEL']);
  });

  it('leaves METRICS_TOKEN unset unless an install chose one', () => {
    expect(loadEnv(completeEnv).METRICS_TOKEN).toBeUndefined();
    expect(loadEnv(envWith({ METRICS_TOKEN: '  ' })).METRICS_TOKEN).toBeUndefined();
  });

  it('refuses a metrics token short enough to guess', () => {
    expectInvalidKeys(envWith({ METRICS_TOKEN: 'short' }), ['METRICS_TOKEN']);
    expect(loadEnv(envWith({ METRICS_TOKEN: 'x'.repeat(16) })).METRICS_TOKEN).toBe('x'.repeat(16));
  });

  it('never quotes the metrics token in the error it throws', () => {
    const failure = expectInvalidKeys(envWith({ METRICS_TOKEN: 'secret' }), ['METRICS_TOKEN']);

    expect(failure.message).not.toContain('secret');
  });

  it('parses the port and the outbound allow-list', () => {
    const env = loadEnv(
      envWith({ PORT: '8080', OUTBOUND_ALLOW_CIDRS: '10.0.0.0/8, fd00::/8 ,192.168.1.1/32' }),
    );

    expect(env.PORT).toBe(8080);
    expect(env.OUTBOUND_ALLOW_CIDRS).toEqual(['10.0.0.0/8', 'fd00::/8', '192.168.1.1/32']);
  });

  it('treats a blank value as unset so a template key can stay empty', () => {
    const env = loadEnv(
      envWith({ PORT: '', APP_MASTER_KEY_PREVIOUS: '   ', OUTBOUND_ALLOW_CIDRS: '' }),
    );

    expect(env.PORT).toBe(3000);
    expect(env.APP_MASTER_KEY_PREVIOUS).toBeUndefined();
    expect(env.OUTBOUND_ALLOW_CIDRS).toEqual([]);
  });

  it('accepts a previous master key during rotation', () => {
    const previous = Buffer.alloc(32, 9).toString('base64');

    expect(loadEnv(envWith({ APP_MASTER_KEY_PREVIOUS: previous })).APP_MASTER_KEY_PREVIOUS).toBe(
      previous,
    );
  });

  it('freezes the result so nothing can rewrite configuration at runtime', () => {
    const env = loadEnv(completeEnv);

    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.OUTBOUND_ALLOW_CIDRS)).toBe(true);
  });

  it('reports every invalid key in one error', () => {
    const failure = expectInvalidKeys(envWith({ APP_ROLE: 'relay', PORT: 'http', S3_REGION: '' }), [
      'APP_ROLE',
      'PORT',
      'S3_REGION',
    ]);

    expect(failure.message).toContain('APP_ROLE');
    expect(failure.message).toContain('PORT');
    expect(failure.message).toContain('S3_REGION');
  });

  it('names the key but never the value it was given', () => {
    const failure = expectInvalidKeys(
      envWith({ APP_MASTER_KEY: 'not-a-key', S3_SECRET_ACCESS_KEY: '' }),
      ['APP_MASTER_KEY', 'S3_SECRET_ACCESS_KEY'],
    );

    expect(failure.message).not.toContain('not-a-key');
  });

  it('rejects a master key that does not decode to exactly 32 bytes', () => {
    expectInvalidKeys(envWith({ APP_MASTER_KEY: Buffer.alloc(31, 1).toString('base64') }), [
      'APP_MASTER_KEY',
    ]);
    expectInvalidKeys(envWith({ APP_MASTER_KEY: Buffer.alloc(33, 1).toString('base64') }), [
      'APP_MASTER_KEY',
    ]);
    expectInvalidKeys(envWith({ APP_MASTER_KEY: 'x'.repeat(44) }), ['APP_MASTER_KEY']);
    expectInvalidKeys(envWith({ APP_MASTER_KEY_PREVIOUS: 'also-not-a-key' }), [
      'APP_MASTER_KEY_PREVIOUS',
    ]);
  });

  it('rejects a URL with the wrong scheme', () => {
    expectInvalidKeys(envWith({ DATABASE_URL: 'mysql://db:3306/helpdock' }), ['DATABASE_URL']);
    expectInvalidKeys(envWith({ REDIS_URL: 'http://redis:6379' }), ['REDIS_URL']);
    expectInvalidKeys(envWith({ APP_URL: 'support.example.com' }), ['APP_URL']);
  });

  it('rejects a port outside the valid range', () => {
    expectInvalidKeys(envWith({ PORT: '0' }), ['PORT']);
    expectInvalidKeys(envWith({ PORT: '70000' }), ['PORT']);
    expectInvalidKeys(envWith({ PORT: '80.5' }), ['PORT']);
  });

  it('rejects an entry in the allow-list that is not a CIDR', () => {
    for (const value of ['10.0.0.0', '10.0.0.0/33', '999.0.0.0/8', 'fd00::/129', '10.0.0.0/x']) {
      expectInvalidKeys(envWith({ OUTBOUND_ALLOW_CIDRS: value }), ['OUTBOUND_ALLOW_CIDRS']);
    }
  });

  it('reports a missing required key', () => {
    const { APP_URL: _removed, ...withoutAppUrl } = completeEnv;

    expectInvalidKeys(withoutAppUrl, ['APP_URL']);
  });
});

describe('decodeMasterKey', () => {
  it('returns the 32 raw bytes of a valid key', () => {
    expect(decodeMasterKey(MASTER_KEY)).toEqual(Buffer.alloc(32, 7));
  });

  it('rejects base64 that does not round-trip', () => {
    // `Buffer.from` drops the invalid characters and would otherwise leave a
    // short key looking like a valid one.
    expect(
      decodeMasterKey(`${Buffer.alloc(32, 7).toString('base64').slice(0, 43)}!`),
    ).toBeUndefined();
  });
});

describe('.env.example', () => {
  const template = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  // Everything after the marker is read by `docker/docker-compose.yml` and not
  // by this package, so it is deliberately not a bootstrap key.
  const [bootstrap = '', compose = ''] = template.split(COMPOSE_SECTION_MARKER);
  const keysIn = (section: string): string[] =>
    [...section.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string);

  it('splits the file into a bootstrap section and a Compose-only one', () => {
    expect(template).toContain(COMPOSE_SECTION_MARKER);
    expect(compose).not.toBe('');
  });

  it('documents every bootstrap key exactly once, and nothing else', () => {
    expect(keysIn(bootstrap).sort()).toEqual([...ENV_KEYS].sort());
  });

  it('keeps the Compose-only section free of bootstrap keys', () => {
    // A key in both sections would be documented twice and could drift.
    expect(keysIn(compose).filter((key) => (ENV_KEYS as readonly string[]).includes(key))).toEqual(
      [],
    );
  });

  it('gives every key a description, which is what the failure message quotes', () => {
    for (const key of ENV_KEYS) {
      expect(envSchema.shape[key].description ?? '').not.toBe('');
    }
  });
});

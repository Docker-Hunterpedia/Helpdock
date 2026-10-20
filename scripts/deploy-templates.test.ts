import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { envSchema } from '../packages/config/src/env.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
// Only fixtures, never a developer's .env or provider credentials.
const fixture: Record<string, string> = {
  APP_URL: 'https://support.example.com',
  APP_MASTER_KEY: Buffer.alloc(32, 251).toString('base64'),
  METRICS_TOKEN: 'metrics-token-for-contract-test-only-337',
  HD_SETUP_TOKEN: 'setup-token-for-contract-test-only-337',
  POSTGRES_PASSWORD: 'ownerPassword337',
  HELPDOCK_APP_PASSWORD: 'appPassword337',
  S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'helpdock',
  S3_ACCESS_KEY_ID: 'test-access',
  S3_SECRET_ACCESS_KEY: 'test-secret',
};
const required = Object.entries(envSchema.shape)
  .filter(([, schema]) => !schema.safeParse(undefined).success)
  .map(([key]) => key);

interface ComposeService {
  environment?: Record<string, string>;
  image?: string;
  ports?: { host_ip: string; target: number; published: string }[];
  deploy?: { replicas?: number };
  healthcheck?: { disable?: boolean; test?: string[] };
}
interface Compose {
  services: Record<string, ComposeService>;
}
interface RenderEnv {
  key: string;
  value?: string;
  sync?: boolean;
  generateValue?: boolean;
  fromDatabase?: { name: string; property: string };
  fromService?: { name: string; envVarKey?: string; property?: string };
}
interface RenderService {
  type: string;
  name: string;
  envVars?: RenderEnv[];
  image?: { url: string };
  maxmemoryPolicy?: string;
  healthCheckPath?: string;
}
interface Blueprint {
  services: RenderService[];
  databases: { name: string }[];
}
interface DoEnv {
  key: string;
  value?: string;
}
interface DoComponent {
  name: string;
  image: { tag: string; registry_type: string };
  envs: DoEnv[];
}
interface DoSpec {
  envs: DoEnv[];
  services: DoComponent[];
  workers: DoComponent[];
  databases: { name: string; engine: string; production: boolean; cluster_name: string }[];
}

const compose = (file: string, env: Record<string, string> = fixture): Compose => {
  const dir = mkdtempSync(join(tmpdir(), 'helpdock-template-'));
  try {
    // Dokploy writes an unquoted .env: exercise Compose interpolation, too.
    const envFile = join(dir, '.env');
    writeFileSync(
      envFile,
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    const inherited = { ...process.env };
    for (const key of Object.keys(env)) delete inherited[key];
    return JSON.parse(
      execFileSync(
        'docker',
        ['compose', '--env-file', envFile, '-f', join(root, file), 'config', '--format', 'json'],
        {
          env: inherited,
          encoding: 'utf8',
        },
      ),
    ) as Compose;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const assertEnvironment = (env: Record<string, string>, role: string): void => {
  expect(Object.keys(env)).toEqual(expect.arrayContaining(required));
  expect(env.APP_ROLE).toBe(role);
  expect(env.NODE_ENV).toBe('production');
  // Presence alone misses invalid master keys, malformed URLs and wrong roles.
  expect(envSchema.safeParse(env).success).toBe(true);
};

describe('deploy template contracts (#337, M15-08 / M15-13)', () => {
  it('removes Caddy and publishes exactly one loopback API with the real Compose merge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helpdock-compose-'));
    try {
      for (const file of ['docker-compose.yml', 'docker-compose.external-proxy.yml']) {
        writeFileSync(join(dir, file), read(`docker/${file}`));
      }
      writeFileSync(
        join(dir, '.env'),
        Object.entries({
          ...fixture,
          TRUST_PROXY: 'false',
          APP_ROLE: 'api',
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://helpdock_app:test@postgres/helpdock',
          DATABASE_MIGRATION_URL: 'postgres://helpdock_owner:test@postgres/helpdock',
          REDIS_URL: 'redis://redis:6379',
        })
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      );
      const args = [
        'compose',
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.external-proxy.yml',
        'config',
        '--format',
        'json',
      ];
      const inherited = { ...process.env };
      for (const key of Object.keys(fixture)) delete inherited[key];
      delete inherited.TRUST_PROXY;
      delete inherited.ADMIN_HOST;
      delete inherited.API_HOST;
      // Compose interpolates the base before removing Caddy, so these remain required.
      expect(() =>
        execFileSync('docker', args, { cwd: dir, env: inherited, stdio: 'pipe' }),
      ).toThrow(/ADMIN_HOST/);
      writeFileSync(join(dir, '.env'), '\nADMIN_HOST=support.example.com', { flag: 'a' });
      expect(() =>
        execFileSync('docker', args, { cwd: dir, env: inherited, stdio: 'pipe' }),
      ).toThrow(/API_HOST/);
      writeFileSync(join(dir, '.env'), '\nAPI_HOST=api.example.com', { flag: 'a' });
      const merged = JSON.parse(
        execFileSync('docker', args, { cwd: dir, env: inherited, encoding: 'utf8' }),
      ) as Compose;
      expect(merged.services.caddy).toBeUndefined();
      expect(merged.services.api?.ports).toEqual([
        expect.objectContaining({ host_ip: '127.0.0.1', target: 3000, published: '3000' }),
      ]);
      expect(merged.services.api?.deploy?.replicas).toBe(1);
      for (const [name, service] of Object.entries(merged.services)) {
        if (name !== 'api') expect(service.ports).toBeUndefined();
      }
      for (const role of ['api', 'worker']) {
        assertEnvironment(merged.services[role]?.environment ?? {}, role);
        expect(merged.services[role]?.environment?.TRUST_PROXY).toBe('uniquelocal');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves Dokploy generated secrets and exposes only the domain-config API service', () => {
    const toml = parseToml(read('deploy/dokploy/template.toml')) as unknown as {
      variables: Record<string, string>;
      config: {
        env: Record<string, string>;
        domains: { serviceName: string; port: number; host: string }[];
      };
    };
    const helpers: Record<string, string> = {
      domain: 'support.example.com',
      'base64:32': fixture.APP_MASTER_KEY ?? '',
      'hash:32': 'a'.repeat(64),
      'password:48': 'Ab9!@#$%^&*'.repeat(5).slice(0, 48),
    };
    const substitute = (value: string, variables: Record<string, string>): string =>
      value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
        expect(variables[key], `unresolved Dokploy helper: ${key}`).toBeDefined();
        return variables[key] ?? '';
      });
    const variables = Object.fromEntries(
      Object.entries(toml.variables).map(([key, value]) => [key, substitute(value, helpers)]),
    );
    // Reject unsafe password helpers on every variable flowing into container env.
    const assertSafe = (value: string): void => {
      for (const [, key] of value.matchAll(/\$\{([^}]+)\}/g)) {
        expect(key).not.toMatch(/^password:/);
        if (key && toml.variables[key]) assertSafe(toml.variables[key]);
      }
    };
    for (const value of Object.values(toml.config.env)) assertSafe(value);
    const generated = Object.fromEntries(
      Object.entries(toml.config.env).map(([key, value]) => [key, substitute(value, variables)]),
    );
    const env = { ...fixture, ...generated };
    for (const key of Object.keys(env).filter((key) => key.startsWith('S3_'))) {
      env[key] = fixture[key] ?? generated[key] ?? '';
    }
    const model = compose('deploy/dokploy/docker-compose.yml', env);
    expect(toml.config.domains).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Dokploy resolves this placeholder.
      { serviceName: 'api', port: 3000, host: '${main_domain}' },
    ]);
    expect(model.services.caddy).toBeUndefined();
    for (const role of ['api', 'worker']) {
      const service = model.services[role];
      expect(service?.ports).toBeUndefined();
      assertEnvironment(service?.environment ?? {}, role);
      expect(service?.environment?.HD_SETUP_TOKEN).toBe(generated.HD_SETUP_TOKEN);
      expect(service?.environment?.METRICS_TOKEN).toBe(generated.METRICS_TOKEN);
      expect(service?.environment?.METRICS_TOKEN?.length).toBeGreaterThanOrEqual(16);
    }
    const metadata = JSON.parse(read('deploy/dokploy/meta.json')) as { logo: string };
    expect(read(`deploy/dokploy/${metadata.logo}`)).toContain('<svg');
  });

  it('uses real base64 bytes and shared credentials in the Coolify service template', () => {
    const model = compose('deploy/coolify/docker-compose.yml', {
      ...fixture,
      SERVICE_URL_API_3000: fixture.APP_URL ?? '',
      SERVICE_REALBASE64_32_MASTERKEY: fixture.APP_MASTER_KEY ?? '',
      SERVICE_REALBASE64_32_METRICS: fixture.APP_MASTER_KEY ?? '',
      SERVICE_PASSWORD_64_SETUP: 's'.repeat(64),
      SERVICE_PASSWORD_64_POSTGRES: 'o'.repeat(64),
      SERVICE_PASSWORD_64_APP: 'a'.repeat(64),
    });
    for (const role of ['api', 'worker']) {
      assertEnvironment(model.services[role]?.environment ?? {}, role);
      expect(model.services[role]?.ports).toBeUndefined();
      expect(model.services[role]?.environment?.METRICS_TOKEN?.length).toBeGreaterThanOrEqual(16);
    }
    expect(model.services.caddy).toBeUndefined();
    expect(model.services.api?.environment?.DATABASE_MIGRATION_URL).toContain(
      `:${model.services.postgres?.environment?.POSTGRES_PASSWORD}@`,
    );
  });

  it('covers every required config key on both Render roles with valid references', () => {
    const blueprint = parseYaml(read('render.yaml')) as Blueprint;
    for (const role of ['api', 'worker']) {
      const service = blueprint.services.find((entry) => entry.name === `helpdock-${role}`);
      expect(service).toBeDefined();
      const env = service?.envVars ?? [];
      expect(env.map((entry) => entry.key)).toEqual(expect.arrayContaining(required));
      expect(env.find((entry) => entry.key === 'APP_ROLE')?.value).toBe(role);
      for (const entry of env) {
        expect(
          entry.value !== undefined ||
            entry.sync === false ||
            entry.generateValue === true ||
            entry.fromDatabase !== undefined ||
            entry.fromService !== undefined,
          `${role}.${entry.key} has no source`,
        ).toBe(true);
        if (entry.fromService) {
          const source = blueprint.services.find(
            (candidate) => candidate.name === entry.fromService?.name,
          );
          expect(source).toBeDefined();
          if (entry.fromService.envVarKey) {
            expect(
              source?.envVars?.some((candidate) => candidate.key === entry.fromService?.envVarKey),
            ).toBe(true);
          }
        }
        if (entry.fromDatabase) {
          expect(blueprint.databases.some((db) => db.name === entry.fromDatabase?.name)).toBe(true);
        }
      }
      expect(service?.image?.url).toMatch(/helpdock:\d+\.\d+\.\d+$/);
    }
    expect(blueprint.services.find((entry) => entry.type === 'web')?.envVars).toContainEqual({
      key: 'METRICS_TOKEN',
      generateValue: true,
    });
    expect(blueprint.services.find((entry) => entry.type === 'keyvalue')?.maxmemoryPolicy).toBe(
      'noeviction',
    );
    expect(blueprint.services.find((entry) => entry.type === 'web')?.healthCheckPath).toBe(
      '/ready',
    );
  });

  it('provides one DO import spec with shared required env and operator-supplied metrics secret', () => {
    const spec = parseYaml(read('.do/app.yaml')) as DoSpec;
    expect(existsSync(join(root, '.do/deploy.template.yaml'))).toBe(false);
    expect(spec.envs.find((entry) => entry.key === 'METRICS_TOKEN')).toMatchObject({
      value: '',
      type: 'SECRET',
    });
    for (const component of [...spec.services, ...spec.workers]) {
      const env = [...spec.envs, ...component.envs];
      expect(env.map((entry) => entry.key)).toEqual(expect.arrayContaining(required));
      expect(component.envs.find((entry) => entry.key === 'APP_ROLE')?.value).toBe(component.name);
      expect(component.image.registry_type).toBe('GHCR');
      expect(component.image.tag).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(spec.databases.map((entry) => entry.engine).sort()).toEqual(['PG', 'VALKEY']);
    expect(spec.databases.every((db) => db.production && db.cluster_name.length > 0)).toBe(true);
  });
  it('pins all platform roles to the same explicit release', () => {
    const blueprint = parseYaml(read('render.yaml')) as Blueprint;
    const spec = parseYaml(read('.do/app.yaml')) as DoSpec;
    const images = [
      ...blueprint.services.filter((service) => service.image).map((service) => service.image?.url),
      ...[...spec.services, ...spec.workers].map(
        (component) => `ghcr.io/docker-hunterpedia/helpdock:${component.image.tag}`,
      ),
      ...['dokploy', 'coolify'].flatMap((platform) => {
        const model = compose(`deploy/${platform}/docker-compose.yml`, {
          ...fixture,
          SERVICE_URL_API_3000: fixture.APP_URL ?? '',
          SERVICE_REALBASE64_32_MASTERKEY: fixture.APP_MASTER_KEY ?? '',
          SERVICE_REALBASE64_32_METRICS: fixture.APP_MASTER_KEY ?? '',
          SERVICE_PASSWORD_64_SETUP: 's'.repeat(64),
          SERVICE_PASSWORD_64_POSTGRES: 'o'.repeat(64),
          SERVICE_PASSWORD_64_APP: 'a'.repeat(64),
        });
        return ['api', 'worker'].map((role) => model.services[role]?.image);
      }),
    ];
    expect(images).toHaveLength(8);
    expect(images[0]).toMatch(/^ghcr\.io\/docker-hunterpedia\/helpdock:\d+\.\d+\.\d+$/);
    expect(new Set(images).size).toBe(1);
    const metadata = JSON.parse(read('deploy/dokploy/meta.json')) as { version: string };
    expect(metadata.version).toBe(images[0]?.split(':').at(-1));
  });
});

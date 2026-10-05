import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  type BrandDomain,
  brandDomains,
  brands,
  createDb,
  type Db,
  type DbHandle,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import { createDnsResolver, type DnsBackend, type TlsProbeResult } from '@helpdock/net';
import type { CustomDomain, CustomDomainList, ErrorResponse } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { BrandHostResolver } from './brand-host.js';
import { scheduleDomainChecks } from './domain-jobs.js';
import { DomainVerifier } from './domain-verifier.js';
import { DomainsRepository } from './domains.repository.js';
import { DOMAIN_CHECK_REQUESTED_EVENT } from './domains.service.js';

/**
 * M5-07 against a real Postgres and a real Redis, with DNS and TLS replaced by
 * stubs the suite controls (the real resolver's error handling is in front of
 * them: the stub is a `DnsBackend`, so `createDnsResolver` still classifies).
 *
 * 1. **The Domains routes**: Admin only, the hostname refusals, the outbox
 *    request and the audit row with every change, "Check now"'s cooldown.
 * 2. **Verification**: pending until both records are seen, verified and
 *    primary when they are, the TLS outcome, Cloudflare, a removed record,
 *    and a DNS timeout that changes nothing.
 * 3. **`/internal/domain-check`**: 200 only for a verified domain that
 *    Cloudflare does not proxy.
 * 4. **Host routing**: `BrandHostResolver` maps a verified host to its brand.
 * 5. **Tenancy** (DOMAIN-RULES §1.6): another brand's Admin, route or job
 *    cannot read or touch a brand's domains.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const PASSWORD = 'a domains test password';
const CONTAINER_STARTUP_MS = 180_000;
/** `APP_URL`'s host, which is also the CNAME target: `HELPCENTER_CNAME_TARGET` is unset. */
const CNAME_TARGET = 'support.example.com';
const TARGET_ADDRESS = '203.0.113.10';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the custom-domain integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

/** What the stub name server answers, by record type and name. */
interface Zone {
  cname: Map<string, string[]>;
  txt: Map<string, string[]>;
  a: Map<string, string[]>;
  failing: Set<string>;
}

const failure = (code: string): Error => Object.assign(new Error(code), { code });

/** A name server over whatever zone the current case set up. */
const stubBackend = (current: () => Zone): DnsBackend => {
  const answer =
    (records: (zone: Zone) => Map<string, string[]>) =>
    async (name: string): Promise<string[]> => {
      const zone = current();
      if (zone.failing.has(name)) {
        throw failure('ETIMEOUT');
      }
      const found = records(zone).get(name);
      if (found === undefined) {
        throw failure('ENOTFOUND');
      }
      return found;
    };
  return {
    resolveCname: answer((zone) => zone.cname),
    resolveTxt: async (name) => (await answer((zone) => zone.txt)(name)).map((value) => [value]),
    resolve4: answer((zone) => zone.a),
    resolve6: async () => {
      throw failure('ENODATA');
    },
  };
};

describe.skipIf(!hasDocker)('custom domains', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let brandB: string;
  let adminA: string;
  let adminB: string;
  let agentA: string;
  let zone: Zone;
  let tls: TlsProbeResult;
  let probed: string[];
  let verifier: DomainVerifier;

  const envFor = (): Env =>
    ({
      APP_URL: `https://${CNAME_TARGET}`,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: postgres
        .getConnectionUri()
        .replace(/\/\/[^@]+@/, `//helpdock_app:${APP_ROLE_PASSWORD}@`)
        .replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      DATABASE_MIGRATION_URL: postgres.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://bucket.test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock-domains',
      S3_ACCESS_KEY_ID: 'unused',
      S3_SECRET_ACCESS_KEY: 'unused',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const db = (): Db => runtime.db;
  const brandA = (): string => seeded.brandId;

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    token: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url: path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const domainCheck = (domain: string) =>
    app.inject({ method: 'GET', url: `/internal/domain-check?domain=${domain}` });

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

  const staff = async (
    brandId: string,
    role: 'admin' | 'agent',
    hasher: PasswordHasher,
  ): Promise<string> => {
    const id = uuidv7();
    const email = `${role}-${id}@helpdock.test`;
    await db()
      .insert(users)
      .values({
        id,
        email,
        name: role,
        status: 'active',
        passwordHash: await hasher.hash(PASSWORD),
      });
    await withSystem(db(), brandId, (tx) =>
      tx.insert(userBrandRoles).values({ userId: id, brandId, role }),
    );
    return signIn(email, PASSWORD);
  };

  const rowOf = async (brandId: string, id: string): Promise<BrandDomain | undefined> =>
    withSystem(db(), brandId, async (tx) => {
      const [row] = await tx.select().from(brandDomains).where(eq(brandDomains.id, id));
      return row;
    });

  const outboxFor = (brandId: string, domainId: string) =>
    withSystem(db(), brandId, (tx) =>
      tx
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.event, DOMAIN_CHECK_REQUESTED_EVENT),
            sql`${outbox.payload}->>'domainId' = ${domainId}`,
          ),
        ),
    );

  const auditFor = (brandId: string, domainId: string) =>
    withSystem(db(), brandId, async (tx) =>
      (
        await tx
          .select({ action: auditLog.action, actorType: auditLog.actorType })
          .from(auditLog)
          .where(eq(auditLog.targetId, domainId))
      ).map((row) => `${row.actorType}:${row.action}`),
    );

  const add = async (domain: string, token = adminA, brandId = brandA()) =>
    call<CustomDomain & ErrorResponse>('POST', `/api/brands/${brandId}/domains`, token, {
      domain,
    });

  /** Publishes both records for `domain` in the stub zone. */
  const publish = (domain: string, value: string, pointing: 'cname' | 'cloudflare' = 'cname') => {
    zone.txt.set(`_helpdock.${domain}`, [value]);
    if (pointing === 'cname') {
      zone.cname.set(domain, [CNAME_TARGET]);
    } else {
      zone.a.set(domain, ['104.21.48.12']);
    }
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });
    await app.listen({ port: 0, host: '127.0.0.1' });

    seeded = await seedDevInstall({ db: db(), env: envFor() });
    const [other] = await db()
      .insert(brands)
      .values({ name: 'Globex', prefix: 'GLOBEX' })
      .returning({ id: brands.id });
    brandB = other?.id ?? '';

    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const hasher = new PasswordHasher(masterKey);
    adminA = await signIn(seeded.email, seeded.password);
    agentA = await staff(brandA(), 'agent', hasher);
    adminB = await staff(brandB, 'admin', hasher);

    verifier = new DomainVerifier({
      db: db(),
      log: silentLogger,
      repository: new DomainsRepository(),
      cnameTarget: CNAME_TARGET,
      probes: {
        dns: createDnsResolver({ backend: stubBackend(() => zone) }),
        tls: async (hostname) => {
          probed.push(hostname);
          return tls;
        },
      },
    });
  }, 400_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    zone = {
      cname: new Map(),
      txt: new Map(),
      a: new Map([[CNAME_TARGET, [TARGET_ADDRESS]]]),
      failing: new Set(),
    };
    tls = { status: 'valid', validTo: new Date('2027-01-01T00:00:00Z') };
    probed = [];
    for (const brandId of [brandA(), brandB]) {
      await withSystem(db(), brandId, (tx) => tx.delete(brandDomains));
    }
  });

  // ------------------------------------------------------------------ routes

  describe('the Domains routes', () => {
    it('are the Admin’s: an Agent may not even read them', async () => {
      expect((await call('GET', `/api/brands/${brandA()}/domains`, agentA)).status).toBe(403);
      expect((await add('help.acme-support.com', agentA)).status).toBe(403);
    });

    it('add a domain as pending, with the records to publish, a check request and an audit row', async () => {
      const response = await add(' Help.Acme-Support.com. ');

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        domain: 'help.acme-support.com',
        state: 'pending',
        primary: false,
        cloudflareProxied: false,
        records: {
          cname: { name: 'help.acme-support.com', value: CNAME_TARGET, seen: false },
          txt: { name: '_helpdock.help.acme-support.com', seen: false },
        },
      });
      expect(response.body.records.txt.value).toMatch(/^helpdock-verify=[0-9a-f]{32}$/);
      expect(await outboxFor(brandA(), response.body.id)).toHaveLength(1);
      expect(await auditFor(brandA(), response.body.id)).toEqual(['staff:domain.added']);

      const list = await call<CustomDomainList>('GET', `/api/brands/${brandA()}/domains`, adminA);
      expect(list.body).toMatchObject({ cnameTarget: CNAME_TARGET });
      expect(list.body.domains.map((domain) => domain.domain)).toEqual(['help.acme-support.com']);
    });

    it('store a Unicode name as the punycode DNS will see', async () => {
      const response = await add('دعم.acme-support.com');

      expect(response.status).toBe(201);
      expect(response.body.domain).toBe('xn--ugbu0b.acme-support.com');
    });

    it.each([
      ['https://help.acme-support.com', 400, 'domain-invalid'],
      ['10.0.0.5', 400, 'domain-invalid'],
      ['printer.local', 400, 'domain-not-public'],
      [CNAME_TARGET, 409, 'domain-reserved'],
    ])('refuse %j with %i %s', async (domain, status, reason) => {
      const response = await add(domain);

      expect(response.status).toBe(status);
      expect(response.body.error.domains).toEqual({ reason });
    });

    it('refuse a host another brand already has, or this one does', async () => {
      await add('help.shared-name.com');

      expect((await add('help.shared-name.com')).body.error.domains).toEqual({
        reason: 'domain-taken',
      });
      expect((await add('help.shared-name.com', adminB, brandB)).body.error.domains).toEqual({
        reason: 'domain-taken',
      });
    });

    it('queue a check on "Check now", but not twice within the cooldown', async () => {
      const { body: domain } = await add('help.check-now.com');
      // The add itself was a request; the cooldown starts from it.
      await withSystem(db(), brandA(), (tx) =>
        tx
          .update(brandDomains)
          .set({ checkRequestedAt: new Date(Date.now() - 60_000) })
          .where(eq(brandDomains.id, domain.id)),
      );

      const first = await call(
        'POST',
        `/api/brands/${brandA()}/domains/${domain.id}/check`,
        adminA,
      );
      const second = await call(
        'POST',
        `/api/brands/${brandA()}/domains/${domain.id}/check`,
        adminA,
      );

      expect([first.status, second.status]).toEqual([202, 202]);
      expect(await outboxFor(brandA(), domain.id)).toHaveLength(2);
    });

    it('refuse to make an unverified domain primary', async () => {
      const { body: domain } = await add('help.unverified.com');

      const response = await call<ErrorResponse>(
        'PATCH',
        `/api/brands/${brandA()}/domains/${domain.id}`,
        adminA,
        { primary: true },
      );

      expect(response.status).toBe(409);
      expect(response.body.error.domains).toEqual({ reason: 'domain-not-verified' });
    });

    it('flag a domain as proxied by Cloudflare, queue a check and audit it', async () => {
      const { body: domain } = await add('help.proxied.com');

      const response = await call<CustomDomain>(
        'PATCH',
        `/api/brands/${brandA()}/domains/${domain.id}`,
        adminA,
        { cloudflareProxied: true },
      );

      expect(response.body.cloudflareProxied).toBe(true);
      expect(await outboxFor(brandA(), domain.id)).toHaveLength(2);
      expect(await auditFor(brandA(), domain.id)).toContain('staff:domain.updated');
    });

    it('remove a domain, and audit it', async () => {
      const { body: domain } = await add('help.removed.com');

      expect(
        (await call('DELETE', `/api/brands/${brandA()}/domains/${domain.id}`, adminA)).status,
      ).toBe(204);
      expect(await rowOf(brandA(), domain.id)).toBeUndefined();
      expect(await auditFor(brandA(), domain.id)).toContain('staff:domain.removed');
      expect(
        (await call('DELETE', `/api/brands/${brandA()}/domains/${domain.id}`, adminA)).status,
      ).toBe(404);
    });

    it('validate their parameters and bodies', async () => {
      expect((await call('GET', '/api/brands/not-a-uuid/domains', adminA)).status).toBe(400);
      expect((await add('')).status).toBe(400);
      const { body: domain } = await add('help.validated.com');
      expect(
        (await call('PATCH', `/api/brands/${brandA()}/domains/${domain.id}`, adminA, {})).status,
      ).toBe(400);
    });
  });

  // ------------------------------------------------------------ verification

  describe('verification', () => {
    const txtOf = async (id: string): Promise<string> => {
      const row = await rowOf(brandA(), id);
      return `helpdock-verify=${row?.txtToken ?? ''}`;
    };

    it('stays pending until both records are seen, and says which one it saw', async () => {
      const { body: domain } = await add('help.pending.com');
      zone.txt.set('_helpdock.help.pending.com', [await txtOf(domain.id)]);

      expect(await verifier.checkOne(brandA(), domain.id, 'job-1')).toBe('pending');
      const row = await rowOf(brandA(), domain.id);
      expect(row).toMatchObject({ verifiedAt: null, cnameSeenAt: null });
      expect(row?.txtSeenAt).toBeInstanceOf(Date);
      expect(probed).toEqual([]);
      expect((await domainCheck('help.pending.com')).statusCode).toBe(403);
    });

    it('verifies, makes the first verified domain primary, probes TLS and lets Caddy issue', async () => {
      const { body: domain } = await add('help.verified.com');
      publish('help.verified.com', await txtOf(domain.id));

      expect(await verifier.checkOne(brandA(), domain.id, 'job-2')).toBe('verified');

      expect(probed).toEqual(['help.verified.com']);
      expect(await rowOf(brandA(), domain.id)).toMatchObject({
        isPrimary: true,
        failureReason: null,
      });
      expect(await auditFor(brandA(), domain.id)).toContain('system:domain.verified');
      const list = await call<CustomDomainList>('GET', `/api/brands/${brandA()}/domains`, adminA);
      expect(list.body.domains[0]).toMatchObject({
        state: 'verified',
        tls: 'issued',
        primary: true,
        records: { cname: { seen: true }, txt: { seen: true } },
      });

      const check = await domainCheck('HELP.Verified.com.');
      expect(check.statusCode).toBe(200);
      expect(check.json()).toEqual({ domain: 'help.verified.com' });
    });

    it('moves primary to another verified domain, and back when the primary is removed', async () => {
      const { body: first } = await add('help.first.com');
      const { body: second } = await add('help.second.com');
      publish('help.first.com', await txtOf(first.id));
      publish('help.second.com', await txtOf(second.id));
      await verifier.checkOne(brandA(), first.id, 'job-p1');
      await verifier.checkOne(brandA(), second.id, 'job-p2');

      const moved = await call<CustomDomain>(
        'PATCH',
        `/api/brands/${brandA()}/domains/${second.id}`,
        adminA,
        { primary: true },
      );
      expect(moved.body.primary).toBe(true);
      expect((await rowOf(brandA(), first.id))?.isPrimary).toBe(false);

      await call('DELETE', `/api/brands/${brandA()}/domains/${second.id}`, adminA);
      expect((await rowOf(brandA(), first.id))?.isPrimary).toBe(true);
    });

    it('records a certificate that did not come, and still lets Caddy try', async () => {
      const { body: domain } = await add('help.no-cert.com');
      publish('help.no-cert.com', await txtOf(domain.id));
      tls = { status: 'invalid', code: 'ERR_TLS_CERT_ALTNAME_INVALID' };

      expect(await verifier.checkOne(brandA(), domain.id, 'job-3')).toBe('failed');
      expect(await rowOf(brandA(), domain.id)).toMatchObject({
        failureReason: 'certificate_failed',
        failureDetail: 'ERR_TLS_CERT_ALTNAME_INVALID',
        tlsIssuedAt: null,
      });
      expect((await domainCheck('help.no-cert.com')).statusCode).toBe(200);
    });

    it('explains a Cloudflare-proxied name that is not flagged, and needs no handshake once it is', async () => {
      const { body: domain } = await add('help.orange-cloud.com');
      publish('help.orange-cloud.com', await txtOf(domain.id), 'cloudflare');

      await verifier.checkOne(brandA(), domain.id, 'job-4');
      expect(await rowOf(brandA(), domain.id)).toMatchObject({
        failureReason: 'cloudflare_not_flagged',
        failureDetail: '104.21.48.12',
      });

      await call('PATCH', `/api/brands/${brandA()}/domains/${domain.id}`, adminA, {
        cloudflareProxied: true,
      });
      expect(await verifier.checkOne(brandA(), domain.id, 'job-5')).toBe('verified');
      expect(probed).toEqual([]);

      const check = await domainCheck('help.orange-cloud.com');
      expect(check.statusCode).toBe(403);
      expect((check.json() as ErrorResponse).error.message).toMatch(/Cloudflare/);
      const list = await call<CustomDomainList>('GET', `/api/brands/${brandA()}/domains`, adminA);
      expect(list.body.domains[0]).toMatchObject({ state: 'verified', tls: 'cloudflare' });
    });

    it('never un-verifies on a DNS timeout, and does when the TXT record is gone', async () => {
      const { body: domain } = await add('help.lost.com');
      publish('help.lost.com', await txtOf(domain.id));
      await verifier.checkOne(brandA(), domain.id, 'job-6');

      zone.failing.add('_helpdock.help.lost.com');
      expect(await verifier.checkOne(brandA(), domain.id, 'job-7')).toBe('inconclusive');
      expect((await rowOf(brandA(), domain.id))?.verifiedAt).toBeInstanceOf(Date);

      zone.failing.clear();
      zone.txt.delete('_helpdock.help.lost.com');
      expect(await verifier.checkOne(brandA(), domain.id, 'job-8')).toBe('failed');
      expect(await rowOf(brandA(), domain.id)).toMatchObject({
        verifiedAt: null,
        failureReason: 'records_removed',
      });
      expect(await auditFor(brandA(), domain.id)).toContain('system:domain.verification_lost');
      expect((await domainCheck('help.lost.com')).statusCode).toBe(403);
    });

    it('re-checks only the domains that are due', async () => {
      const { body: fresh } = await add('help.fresh.com');
      const { body: recent } = await add('help.recent.com');
      await withSystem(db(), brandA(), (tx) =>
        tx
          .update(brandDomains)
          .set({ lastCheckedAt: new Date() })
          .where(eq(brandDomains.id, recent.id)),
      );

      expect(await verifier.checkDue(brandA(), 'job-9')).toBe(1);
      expect((await rowOf(brandA(), fresh.id))?.lastCheckedAt).toBeInstanceOf(Date);
    });

    it('schedules one run per active brand, keyed by the tick', async () => {
      const added: string[] = [];
      const tick = new Date('2026-09-27T12:15:00Z');

      const count = await scheduleDomainChecks(
        db(),
        { add: async (_payload, jobId) => void added.push(jobId) },
        tick,
      );

      expect(count).toBe(2);
      expect(added.sort()).toEqual(
        [brandA(), brandB].map((id) => `domain.verify.${id}.${String(tick.getTime())}`).sort(),
      );
    });
  });

  // ------------------------------------------------------------ host routing

  describe('host routing', () => {
    it('maps a verified host to its brand and primary host, and nothing else', async () => {
      const { body: domain } = await add('help.routed.com');
      await add('help.unrouted.com');
      publish('help.routed.com', `helpdock-verify=${(await rowOf(brandA(), domain.id))?.txtToken}`);
      await verifier.checkOne(brandA(), domain.id, 'job-10');
      const resolver = new BrandHostResolver({ db: db(), ownHosts: [CNAME_TARGET] });

      await expect(resolver.resolveHelpcenter('Help.Routed.com:443')).resolves.toMatchObject({
        brandId: brandA(),
        domainId: domain.id,
        primaryDomain: 'help.routed.com',
      });
      await expect(resolver.resolve('help.unrouted.com')).resolves.toBeNull();
      await expect(resolver.resolve(CNAME_TARGET)).resolves.toBeNull();
    });
  });

  // ---------------------------------------------------------------- tenancy

  describe('tenancy (DOMAIN-RULES §1.6)', () => {
    it('keeps another brand’s Admin out of this brand’s domains', async () => {
      const { body: domain } = await add('help.brand-a.com');

      expect((await call('GET', `/api/brands/${brandA()}/domains`, adminB)).status).toBe(403);
      const theirs = await call<CustomDomainList>('GET', `/api/brands/${brandB}/domains`, adminB);
      expect(theirs.body.domains).toEqual([]);
      for (const [method, suffix, body] of [
        ['PATCH', '', { cloudflareProxied: true }],
        ['POST', '/check', undefined],
        ['DELETE', '', undefined],
      ] as const) {
        expect(
          (await call(method, `/api/brands/${brandB}/domains/${domain.id}${suffix}`, adminB, body))
            .status,
        ).toBe(404);
      }
      expect(await rowOf(brandA(), domain.id)).toMatchObject({ cloudflareProxied: false });
    });

    it('keeps a job of one brand off another brand’s domain', async () => {
      const { body: domain } = await add('help.brand-a-job.com');
      publish(
        'help.brand-a-job.com',
        `helpdock-verify=${(await rowOf(brandA(), domain.id))?.txtToken}`,
      );

      expect(await verifier.checkOne(brandB, domain.id, 'job-11')).toBe('missing');
      expect(await rowOf(brandA(), domain.id)).toMatchObject({
        lastCheckedAt: null,
        verifiedAt: null,
      });
    });
  });
});

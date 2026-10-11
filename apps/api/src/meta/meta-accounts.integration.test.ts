import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FakeGraph, GraphClient } from '@helpdock/channels';
import { createKeyring, decryptSecret, type Env } from '@helpdock/config';
import {
  auditLog,
  brands,
  createDb,
  type DbHandle,
  departments,
  type MetaAccount,
  metaAccounts,
  outbox,
  users,
  uuidv7,
} from '@helpdock/db';
import type { MetaPlatform, Principal } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { readChannelStatuses } from '../channels/channel-status.js';
import { createLogger } from '../logging/logger.js';

/**
 * Channels › Meta's routes (M10-07) against real Postgres and Redis, with the
 * stand-in for Graph of M10-01.
 *
 * 1. **Who may**: `brand:manage` only, and only in the brand named.
 * 2. **Connecting**: the id and token read against Graph, the app subscribed,
 *    the token stored encrypted and read back as its last four characters,
 *    every refusal of `MetaRefusal` a Graph read or a rule can cause, and the
 *    audit trail and the outbox event each change leaves.
 * 3. **Saving, testing, subscribing, renewing, disconnecting**.
 * 4. **Isolation**: brand B can neither see nor touch brand A's accounts.
 * 5. **The System page's Channels card** lists the accounts.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const ADMIN_A = uuidv7();
const ADMIN_B = uuidv7();
const AGENT_A = uuidv7();
const SUPPORT_A = uuidv7();
const SALES_A = uuidv7();
const SUPPORT_B = uuidv7();

const adminA: Principal = {
  type: 'staff',
  id: ADMIN_A,
  brands: { [BRAND_A]: { role: 'admin', departmentIds: 'all' } },
  installAdmin: false,
};
const adminB: Principal = {
  type: 'staff',
  id: ADMIN_B,
  brands: { [BRAND_B]: { role: 'admin', departmentIds: 'all' } },
  installAdmin: false,
};
const agentA: Principal = {
  type: 'staff',
  id: AGENT_A,
  brands: { [BRAND_A]: { role: 'agent', departmentIds: 'all' } },
  installAdmin: false,
};

const asPrincipal = (principal: Principal): Record<string, string> => ({
  [DEV_PRINCIPAL_HEADER]: JSON.stringify(principal),
});

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M10-07 Meta accounts integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Registered {
  readonly id: string;
  readonly token: string;
  /** A WhatsApp number's business account, where Meta keeps its subscription. */
  readonly wabaId?: string;
}

interface ErrorBody {
  readonly error: { readonly meta?: { readonly reason: string } };
}

describe.skipIf(!hasDocker)('Channels › Meta routes (M10-07)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  const graph = new FakeGraph();
  const keyring = createKeyring({ APP_MASTER_KEY: MASTER_KEY });
  let sequence = 0;

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      DATABASE_MIGRATION_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: ['127.0.0.0/8'],
      META_GRAPH_API_ROOT: graph.facebookRoot,
      META_INSTAGRAM_API_ROOT: graph.instagramRoot,
    }) as Env;

  /** An account and a token the stand-in knows, never used before. */
  const fresh = (
    platform: MetaPlatform,
    name = 'Helpdock',
    /** WhatsApp: another number's business account, to share it. */
    sharedWabaId?: string,
  ): Registered => {
    sequence += 1;
    const id =
      platform === 'instagram'
        ? `17841400000${String(sequence).padStart(6, '0')}`
        : `10654035${String(sequence).padStart(7, '0')}`;
    const token = `${platform === 'instagram' ? 'IGAA' : 'EAAG'}${platform}Token${String(sequence).padStart(12, '0')}`;
    const wabaId =
      platform === 'whatsapp'
        ? (sharedWabaId ?? `10229${String(sequence).padStart(10, '0')}`)
        : undefined;
    graph.connect({
      platform,
      id,
      name,
      token,
      ...(platform === 'whatsapp'
        ? { displayPhone: `+1 555 ${String(sequence).padStart(4, '0')}` }
        : {}),
      ...(wabaId === undefined ? {} : { wabaId }),
      ...(platform === 'instagram' ? { username: `helpdock_${String(sequence)}` } : {}),
    });
    return wabaId === undefined ? { id, token } : { id, token, wabaId };
  };

  const accounts = (brandId: string): string => `/api/brands/${brandId}/meta/accounts`;

  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    principal: Principal | null,
    payload?: unknown,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: principal === null ? {} : asPrincipal(principal),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return response;
  };

  /** Connects an account of brand A through the route, as the Connect dialog does. */
  const connect = async (
    platform: MetaPlatform,
    registered: Registered,
    overrides: Record<string, unknown> = {},
  ) => {
    const response = await call('POST', accounts(BRAND_A), adminA, {
      platform,
      externalId: registered.id,
      accessToken: registered.token,
      departmentId: SUPPORT_A,
      ...overrides,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string; [key: string]: unknown }>();
  };

  const row = async (id: string): Promise<MetaAccount> => {
    const [found] = await owner.db.select().from(metaAccounts).where(eq(metaAccounts.id, id));
    if (found === undefined) {
      throw new Error('the account is gone');
    }
    return found;
  };

  const audits = (id: string) =>
    owner.db
      .select({ action: auditLog.action, meta: auditLog.meta, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.targetType, 'meta_account'), eq(auditLog.targetId, id)))
      .orderBy(auditLog.createdAt);

  const changedEvents = (id: string) =>
    owner.db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(eq(outbox.event, 'meta_account.changed'), sql`${outbox.payload}->>'accountId' = ${id}`),
      );

  const reasonOf = (response: { json<T>(): T }): string | undefined =>
    response.json<ErrorBody>().error.meta?.reason;

  beforeAll(async () => {
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      graph.start(),
    ]);

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
      }),
    });
    app = await createApiApp({
      runtime,
      meta: {
        graph: () =>
          new GraphClient({
            root: graph.facebookRoot,
            instagramRoot: graph.instagramRoot,
            allowCidrs: ['127.0.0.0/8'],
          }),
      },
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });

    await runtime.db.insert(brands).values([
      { id: BRAND_A, name: 'Acme', prefix: 'ACME' },
      { id: BRAND_B, name: 'Globex', prefix: 'GLBX' },
    ]);
    await owner.db.insert(users).values([
      { id: ADMIN_A, email: 'lina@example.com', name: 'Lina Haddad' },
      { id: ADMIN_B, email: 'omar@example.com', name: 'Omar Khalil' },
      { id: AGENT_A, email: 'sara@example.com', name: 'Sara Hassan' },
    ]);
    await owner.db.insert(departments).values([
      { id: SUPPORT_A, brandId: BRAND_A, name: 'Support' },
      { id: SALES_A, brandId: BRAND_A, name: 'Sales' },
      { id: SUPPORT_B, brandId: BRAND_B, name: 'Support' },
    ]);
  }, 300_000);

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await graph.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // ---------------------------------------------------------------- who may

  describe('who may', () => {
    it('answers an agent 403, an anonymous caller 401, and another brand’s admin 403', async () => {
      const list = accounts(BRAND_A);

      const statuses = await Promise.all([
        call('GET', list, agentA),
        call('GET', list, null),
        call('GET', list, adminB),
        call('POST', list, agentA, {}),
        call('POST', `${list}/test`, agentA, {}),
        call('DELETE', `${list}/${uuidv7()}`, agentA),
        call('POST', `${list}/${uuidv7()}/refresh`, agentA),
      ]);

      expect(statuses.map((response) => response.statusCode)).toEqual([
        403, 401, 403, 403, 403, 403, 403,
      ]);
    });
  });

  // ------------------------------------------------------------- connecting

  describe('connecting an account', () => {
    it('refuses everything while the install has no app secret, before asking Meta', async () => {
      const { id, token } = fresh('whatsapp');

      const create = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'whatsapp',
        externalId: id,
        accessToken: token,
        departmentId: SUPPORT_A,
      });
      const test = await call('POST', `${accounts(BRAND_A)}/test`, adminA, {
        platform: 'whatsapp',
        externalId: id,
        accessToken: token,
      });

      expect([create.statusCode, reasonOf(create)]).toEqual([409, 'app-not-configured']);
      expect([test.statusCode, reasonOf(test)]).toEqual([409, 'app-not-configured']);
      expect(graph.calls).toHaveLength(0);

      await runtime.settings.set('meta.appSecret', 'integration-app-secret', {
        updatedBy: 'suite',
      });
    });

    it('connects a WhatsApp number: read against Graph, its business account found, subscribed there, stored encrypted', async () => {
      const { id, token, wabaId } = fresh('whatsapp', 'Helpdock Support');
      graph.calls.length = 0;

      const created = await connect('whatsapp', { id, token });

      expect(created).toMatchObject({
        platform: 'whatsapp',
        externalId: id,
        displayName: 'Helpdock Support',
        displayPhone: expect.stringMatching(/^\+1 555 /),
        departmentName: 'Support',
        tokenSet: true,
        tokenHint: token.slice(-4),
        tokenKind: 'system_user',
        tokenExpiresAt: null,
        tokenUpdatedByName: 'Lina Haddad',
        subscribedFields: ['messages'],
        status: 'connected',
        health: 'waiting',
      });
      // The token is in the database, encrypted, and in no response.
      const stored = await row(created.id);
      expect(stored.accessToken).not.toContain(token);
      expect(stored.accessToken).toMatch(/^v1\./);
      expect(decryptSecret(stored.accessToken, keyring)).toBe(token);
      expect(JSON.stringify(created)).not.toContain(token);
      // Graph was read with it, then asked to subscribe.
      expect(graph.callsTo(`/${id}`, 'GET')[0]).toMatchObject({
        token,
        query: { fields: 'id,display_phone_number,verified_name' },
      });
      // The business account comes from the token's own grants, not from anything typed.
      expect(graph.callsTo('/debug_token', 'GET')[0]).toMatchObject({
        query: { input_token: token },
      });
      expect(graph.callsTo(`/${wabaId}/phone_numbers`, 'GET')).toHaveLength(1);
      expect((await row(created.id)).wabaId).toBe(wabaId);
      // Meta keeps the subscription on the business account and takes no field names for it.
      const [subscribe] = graph.callsTo(`/${wabaId}/subscribed_apps`, 'POST');
      expect(subscribe).toMatchObject({ token });
      expect(subscribe?.query.subscribed_fields).toBeUndefined();
      expect(graph.callsTo(`/${id}/subscribed_apps`)).toHaveLength(0);
      expect(graph.subscriptionOf(wabaId ?? '')).toEqual(['messages']);
    });

    it('refuses a WhatsApp token that cannot list the business account that owns the number, and stores nothing', async () => {
      const { id, token } = fresh('whatsapp');
      graph.calls.length = 0;
      graph.failures.push({
        status: 403,
        body: { error: { code: 200, message: '(#200) Requires whatsapp_business_management' } },
        match: /phone_numbers/,
      });

      const response = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'whatsapp',
        externalId: id,
        accessToken: token,
        departmentId: SUPPORT_A,
      });

      expect([response.statusCode, reasonOf(response)]).toEqual([400, 'token-other-account']);
      expect(response.body).not.toContain(token);
      expect(
        await owner.db.select().from(metaAccounts).where(eq(metaAccounts.externalId, id)),
      ).toHaveLength(0);
      expect(graph.calls.filter((made) => made.method === 'POST')).toHaveLength(0);
    });

    it('connects a Messenger Page with the fields the inbound service reads', async () => {
      const { id, token } = fresh('messenger', 'Helpdock');

      const created = await connect('messenger', { id, token }, { humanAgentEnabled: true });

      expect(created).toMatchObject({
        platform: 'messenger',
        displayName: 'Helpdock',
        username: 'Helpdock',
        tokenKind: 'page',
        humanAgentEnabled: true,
        status: 'connected',
      });
      expect(created.subscribedFields).toEqual(
        expect.arrayContaining(['messages', 'message_echoes']),
      );
      expect(graph.subscriptionOf(id)).toEqual(created.subscribedFields);
    });

    it('connects an Instagram account from the Instagram host and dates its 60-day token', async () => {
      const { id, token } = fresh('instagram', 'Helpdock');
      graph.calls.length = 0;
      const before = Date.now();

      const created = await connect('instagram', { id, token });

      expect(created).toMatchObject({
        platform: 'instagram',
        username: expect.stringMatching(/^helpdock_/),
        tokenKind: 'instagram_user',
      });
      expect(Date.parse(created.tokenExpiresAt as string) - before).toBeGreaterThan(59 * DAY_MS);
      expect(Date.parse(created.tokenExpiresAt as string) - before).toBeLessThan(61 * DAY_MS);
      expect((await row(created.id)).tokenRefreshedAt).not.toBeNull();
      expect(graph.calls.every((entry) => entry.root === 'instagram')).toBe(true);
      expect(graph.subscriptionOf(id)).toContain('messaging_seen');
    });

    it('keeps the Human Agent switch off for a WhatsApp number whatever the request says', async () => {
      const registered = fresh('whatsapp');

      const created = await connect('whatsapp', registered, { humanAgentEnabled: true });

      expect(created.humanAgentEnabled).toBe(false);
    });

    it('audits the connection by platform and id, never by token, and announces it on the outbox', async () => {
      const registered = fresh('messenger');

      const created = await connect('messenger', registered);

      expect(await audits(created.id)).toEqual([
        {
          action: 'meta_account.created',
          actorId: ADMIN_A,
          meta: { platform: 'messenger', externalId: registered.id },
        },
      ]);
      expect(JSON.stringify(await audits(created.id))).not.toContain(registered.token);
      expect(await changedEvents(created.id)).toEqual([{ payload: { accountId: created.id } }]);
    });

    it('names the account after what Meta says, unless the person typed a name', async () => {
      const registered = fresh('messenger', 'Meta’s name');

      const created = await connect('messenger', registered, { displayName: 'Our own name' });

      expect(created.displayName).toBe('Our own name');
    });

    it('refuses a token Meta does not know', async () => {
      const { id } = fresh('whatsapp');

      const response = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'whatsapp',
        externalId: id,
        accessToken: 'EAAGnobodyEverIssuedThisToken',
        departmentId: SUPPORT_A,
      });

      expect([response.statusCode, reasonOf(response)]).toEqual([400, 'token-invalid']);
      expect(response.body).not.toContain('nobodyEverIssued');
    });

    it('refuses a token for the other product and a token for another account', async () => {
      const page = fresh('messenger');
      const number = fresh('whatsapp');
      const otherNumber = fresh('whatsapp');
      const instagram = fresh('instagram');
      const otherInstagram = fresh('instagram');
      const attempt = (platform: MetaPlatform, externalId: string, accessToken: string) =>
        call('POST', accounts(BRAND_A), adminA, {
          platform,
          externalId,
          accessToken,
          departmentId: SUPPORT_A,
        });

      const mismatch = await attempt('messenger', page.id, instagram.token);
      const mismatchOther = await attempt('instagram', instagram.id, page.token);
      const otherNumberToken = await attempt('whatsapp', number.id, otherNumber.token);
      const otherInstagramToken = await attempt('instagram', otherInstagram.id, instagram.token);

      expect([mismatch.statusCode, reasonOf(mismatch)]).toEqual([400, 'platform-mismatch']);
      expect([mismatchOther.statusCode, reasonOf(mismatchOther)]).toEqual([
        400,
        'platform-mismatch',
      ]);
      expect([otherNumberToken.statusCode, reasonOf(otherNumberToken)]).toEqual([
        400,
        'token-other-account',
      ]);
      expect([otherInstagramToken.statusCode, reasonOf(otherInstagramToken)]).toEqual([
        400,
        'token-other-account',
      ]);
    });

    it('refuses an account that is already connected, in this brand or in another', async () => {
      const registered = fresh('whatsapp');
      await connect('whatsapp', registered);
      graph.calls.length = 0;

      const again = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'whatsapp',
        externalId: registered.id,
        accessToken: registered.token,
        departmentId: SUPPORT_A,
      });
      const elsewhere = await call('POST', accounts(BRAND_B), adminB, {
        platform: 'whatsapp',
        externalId: registered.id,
        accessToken: registered.token,
        departmentId: SUPPORT_B,
      });
      const test = await call('POST', `${accounts(BRAND_B)}/test`, adminB, {
        platform: 'whatsapp',
        externalId: registered.id,
        accessToken: registered.token,
      });

      for (const response of [again, elsewhere, test]) {
        expect([response.statusCode, reasonOf(response)]).toEqual([409, 'account-taken']);
      }
      // Refused by the id alone: Meta was never asked.
      expect(graph.calls).toHaveLength(0);
      expect(
        await owner.db
          .select({ id: metaAccounts.id })
          .from(metaAccounts)
          .where(eq(metaAccounts.externalId, registered.id)),
      ).toHaveLength(1);
    });

    it('refuses a department of another brand, and an id that is not an id', async () => {
      const { id, token } = fresh('messenger');

      const department = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'messenger',
        externalId: id,
        accessToken: token,
        departmentId: SUPPORT_B,
      });
      const shape = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'messenger',
        externalId: 'not-an-id',
        accessToken: token,
        departmentId: SUPPORT_A,
      });

      expect([department.statusCode, reasonOf(department)]).toEqual([404, 'department-not-found']);
      expect(shape.statusCode).toBe(400);
    });

    it('says Meta could not be reached, and stores nothing, when Graph is down', async () => {
      const { id, token } = fresh('messenger');
      graph.failures.push({ status: 503, body: { error: { code: 2, message: 'Unavailable' } } });

      const response = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'messenger',
        externalId: id,
        accessToken: token,
        departmentId: SUPPORT_A,
      });

      expect([response.statusCode, reasonOf(response)]).toEqual([409, 'graph-unreachable']);
      expect(
        await owner.db.select().from(metaAccounts).where(eq(metaAccounts.externalId, id)),
      ).toHaveLength(0);
    });

    it('refuses the connection when Meta refuses for good to subscribe the app, and stores nothing', async () => {
      const { id, token } = fresh('messenger');
      graph.failures.push({
        status: 400,
        body: { error: { code: 200, message: '(#200) Requires pages_manage_metadata permission' } },
        match: /POST .*subscribed_apps/,
      });

      const response = await call('POST', accounts(BRAND_A), adminA, {
        platform: 'messenger',
        externalId: id,
        accessToken: token,
        departmentId: SUPPORT_A,
      });

      expect([response.statusCode, reasonOf(response)]).toEqual([409, 'subscribe-failed']);
      expect(
        await owner.db.select().from(metaAccounts).where(eq(metaAccounts.externalId, id)),
      ).toHaveLength(0);
    });

    it('connects an account whose subscription failed for a moment, marks it, and Subscribe now fixes it', async () => {
      const { id, token } = fresh('messenger');
      graph.failures.push({
        status: 503,
        body: { error: { code: 2, message: 'Unavailable' } },
        match: /POST .*subscribed_apps/,
      });

      const created = await connect('messenger', { id, token });

      expect(created).toMatchObject({
        status: 'unsubscribed',
        subscribedFields: [],
        subscribedAt: null,
        health: 'failing',
      });
      expect(created.lastError).toMatch(/Unavailable/);
      expect(graph.subscriptionOf(id)).toEqual([]);

      const subscribed = await call('POST', `${accounts(BRAND_A)}/${created.id}/subscribe`, adminA);

      expect(subscribed.statusCode).toBe(200);
      expect(subscribed.json()).toMatchObject({
        ok: true,
        subscribedFields: expect.arrayContaining(['messages']),
      });
      expect(graph.subscriptionOf(id)).toContain('messages');
      expect(await row(created.id)).toMatchObject({
        status: 'connected',
        lastError: null,
        lastErrorAt: null,
      });
      expect((await audits(created.id)).map((entry) => entry.action)).toEqual([
        'meta_account.created',
        'meta_account.subscribed',
      ]);
    });
  });

  // ---------------------------------------------------------------- reading

  describe('reading', () => {
    it('lists the brand’s accounts with the token as its last four characters and nothing more', async () => {
      const registered = fresh('messenger', 'Listed Page');
      const created = await connect('messenger', registered);

      const list = await call('GET', accounts(BRAND_A), adminA);
      const one = await call('GET', `${accounts(BRAND_A)}/${created.id}`, adminA);

      expect(list.statusCode).toBe(200);
      expect(list.json<{ accounts: { id: string }[] }>().accounts.map((a) => a.id)).toContain(
        created.id,
      );
      expect(one.json()).toMatchObject({ id: created.id, tokenHint: registered.token.slice(-4) });
      expect(list.body).not.toContain(registered.token);
      expect(one.body).not.toContain(registered.token);
      expect(list.body).not.toMatch(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/);
    });
  });

  // ----------------------------------------------------------------- saving

  describe('saving an account', () => {
    it('moves the routing and the Human Agent switch, and audits the switch', async () => {
      const created = await connect('messenger', fresh('messenger'));

      const saved = await call('PUT', `${accounts(BRAND_A)}/${created.id}`, adminA, {
        displayName: 'Helpdock',
        departmentId: SALES_A,
        humanAgentEnabled: true,
      });

      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        departmentName: 'Sales',
        humanAgentEnabled: true,
        tokenHint: created.tokenHint,
      });
      expect((await audits(created.id)).at(-1)).toEqual({
        action: 'meta_account.updated',
        actorId: ADMIN_A,
        meta: { tokenReplaced: false, departmentChanged: true, humanAgentEnabled: true },
      });
      expect(await changedEvents(created.id)).toHaveLength(2);
    });

    it('replaces the token with one that opens the same account, and brings it back', async () => {
      const first = fresh('messenger');
      const created = await connect('messenger', first);
      await owner.db
        .update(metaAccounts)
        .set({
          status: 'token_expired',
          lastError: 'Error validating access token',
          lastErrorAt: new Date(),
        })
        .where(eq(metaAccounts.id, created.id));
      const replacement = `EAAGreplacementToken${String(++sequence).padStart(12, '0')}`;
      graph.connect({ platform: 'messenger', id: first.id, name: 'Helpdock', token: replacement });

      const saved = await call('PUT', `${accounts(BRAND_A)}/${created.id}`, adminA, {
        displayName: 'Helpdock',
        departmentId: SUPPORT_A,
        humanAgentEnabled: false,
        accessToken: replacement,
      });

      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({
        tokenHint: replacement.slice(-4),
        status: 'connected',
        lastError: null,
      });
      expect(decryptSecret((await row(created.id)).accessToken, keyring)).toBe(replacement);
      expect(saved.body).not.toContain(replacement);
      expect(JSON.stringify(await audits(created.id))).not.toContain(replacement);
    });

    it('finds the business account again with a replacement WhatsApp token, which repairs a row made without one', async () => {
      const first = fresh('whatsapp');
      const created = await connect('whatsapp', first);
      await owner.db
        .update(metaAccounts)
        .set({ wabaId: null })
        .where(eq(metaAccounts.id, created.id));
      const replacement = `EAAGreplacementToken${String(++sequence).padStart(12, '0')}`;
      graph.connect({
        platform: 'whatsapp',
        id: first.id,
        name: 'Helpdock',
        displayPhone: '+1 555 0100',
        token: replacement,
        ...(first.wabaId === undefined ? {} : { wabaId: first.wabaId }),
      });
      graph.calls.length = 0;

      const saved = await call('PUT', `${accounts(BRAND_A)}/${created.id}`, adminA, {
        displayName: 'Helpdock',
        departmentId: SUPPORT_A,
        humanAgentEnabled: false,
        accessToken: replacement,
      });

      expect(saved.statusCode).toBe(200);
      expect((await row(created.id)).wabaId).toBe(first.wabaId);
      expect(graph.callsTo(`/${first.wabaId}/subscribed_apps`, 'POST')).toHaveLength(1);
    });

    it('refuses a replacement token of another account or that Meta does not know, and changes nothing', async () => {
      const first = fresh('whatsapp');
      const other = fresh('whatsapp');
      const created = await connect('whatsapp', first);
      const put = (accessToken: string) =>
        call('PUT', `${accounts(BRAND_A)}/${created.id}`, adminA, {
          displayName: 'Helpdock',
          departmentId: SALES_A,
          humanAgentEnabled: false,
          accessToken,
        });

      const another = await put(other.token);
      const unknown = await put('EAAGnobodyEverIssuedThisToken');

      expect([another.statusCode, reasonOf(another)]).toEqual([400, 'token-other-account']);
      expect([unknown.statusCode, reasonOf(unknown)]).toEqual([400, 'token-invalid']);
      expect(decryptSecret((await row(created.id)).accessToken, keyring)).toBe(first.token);
      expect((await row(created.id)).departmentId).toBe(SUPPORT_A);
    });

    it('refuses a department of another brand', async () => {
      const created = await connect('messenger', fresh('messenger'));

      const response = await call('PUT', `${accounts(BRAND_A)}/${created.id}`, adminA, {
        displayName: 'Helpdock',
        departmentId: SUPPORT_B,
        humanAgentEnabled: false,
      });

      expect([response.statusCode, reasonOf(response)]).toEqual([404, 'department-not-found']);
    });
  });

  // ------------------------------------------------------- test and status

  describe('testing and the status panel', () => {
    it('tests the stored token, and answers a token Meta has invalidated rather than failing', async () => {
      const registered = fresh('messenger', 'Tested Page');
      const created = await connect('messenger', registered);

      const good = await call('POST', `${accounts(BRAND_A)}/${created.id}/test`, adminA);
      graph.expiredTokens.add(registered.token);
      const dead = await call('POST', `${accounts(BRAND_A)}/${created.id}/test`, adminA);
      graph.expiredTokens.delete(registered.token);

      expect(good.statusCode).toBe(200);
      expect(good.json()).toMatchObject({
        ok: true,
        name: 'Tested Page',
        externalId: registered.id,
      });
      expect(dead.statusCode).toBe(200);
      expect(dead.json()).toMatchObject({ ok: false, kind: 'token' });
      expect(good.body + dead.body).not.toContain(registered.token);
    });

    it('tests a typed token before anything is stored', async () => {
      const registered = fresh('instagram');

      const good = await call('POST', `${accounts(BRAND_A)}/test`, adminA, {
        platform: 'instagram',
        externalId: registered.id,
        accessToken: registered.token,
      });
      const bad = await call('POST', `${accounts(BRAND_A)}/test`, adminA, {
        platform: 'instagram',
        externalId: registered.id,
        accessToken: 'IGAAnobodyEverIssuedThisToken',
      });

      expect(good.json()).toMatchObject({
        ok: true,
        username: expect.stringMatching(/^helpdock_/),
        tokenExpiresAt: expect.any(String),
      });
      expect(bad.json()).toMatchObject({ ok: false, kind: 'token' });
      expect(
        await owner.db
          .select()
          .from(metaAccounts)
          .where(eq(metaAccounts.externalId, registered.id)),
      ).toHaveLength(0);
    });

    it('shows the row, Meta’s live answer and the Activity card', async () => {
      const registered = fresh('messenger');
      const created = await connect('messenger', registered);

      const response = await call('GET', `${accounts(BRAND_A)}/${created.id}/status`, adminA);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'connected',
        health: 'waiting',
        tokenValid: true,
        liveError: null,
        subscribedFields: expect.arrayContaining(['messages']),
        subscribedApps: [expect.objectContaining({ name: 'Helpdock' })],
        activity: { lastReplyAt: null, failedSends: 0, refusedSends: 0, openTickets: 0 },
      });
      expect(response.body).not.toContain(registered.token);
    });

    it('shows a subscription Meta has dropped, and Subscribe now restores it', async () => {
      const registered = fresh('messenger');
      const created = await connect('messenger', registered);
      graph.dropSubscription(registered.id);

      const dropped = await call('GET', `${accounts(BRAND_A)}/${created.id}/status`, adminA);
      const subscribed = await call('POST', `${accounts(BRAND_A)}/${created.id}/subscribe`, adminA);
      const restored = await call('GET', `${accounts(BRAND_A)}/${created.id}/status`, adminA);

      expect(dropped.json<{ subscribedApps: unknown[] }>().subscribedApps).toEqual([]);
      expect(subscribed.json()).toMatchObject({ ok: true });
      expect(restored.json<{ subscribedApps: unknown[] }>().subscribedApps).toHaveLength(1);
    });

    it('reads and restores a WhatsApp number’s subscription on its business account', async () => {
      const registered = fresh('whatsapp');
      const created = await connect('whatsapp', registered);
      const wabaId = registered.wabaId ?? '';
      graph.dropSubscription(wabaId);
      graph.calls.length = 0;

      const dropped = await call('GET', `${accounts(BRAND_A)}/${created.id}/status`, adminA);
      const subscribed = await call('POST', `${accounts(BRAND_A)}/${created.id}/subscribe`, adminA);
      const restored = await call('GET', `${accounts(BRAND_A)}/${created.id}/status`, adminA);

      expect(dropped.json<{ subscribedApps: unknown[] }>().subscribedApps).toEqual([]);
      expect(subscribed.json()).toMatchObject({ ok: true, subscribedFields: ['messages'] });
      expect(restored.json<{ subscribedApps: unknown[] }>().subscribedApps).toHaveLength(1);
      // Never the number's own node, which has no such edge on Meta.
      expect(graph.callsTo(`/${registered.id}/subscribed_apps`)).toHaveLength(0);
      expect(graph.callsTo(`/${wabaId}/subscribed_apps`).length).toBeGreaterThanOrEqual(3);
    });

    it('answers a WhatsApp number that has no business account on record with what to do, and asks Meta nothing', async () => {
      const registered = fresh('whatsapp');
      const created = await connect('whatsapp', registered);
      await owner.db
        .update(metaAccounts)
        .set({ wabaId: null })
        .where(eq(metaAccounts.id, created.id));
      graph.calls.length = 0;

      const subscribed = await call('POST', `${accounts(BRAND_A)}/${created.id}/subscribe`, adminA);
      const status = await call('GET', `${accounts(BRAND_A)}/${created.id}/status`, adminA);

      expect(subscribed.statusCode).toBe(200);
      expect(subscribed.json()).toMatchObject({
        ok: false,
        detail: expect.stringMatching(/disconnect it and connect it again/i),
      });
      expect(status.json()).toMatchObject({
        subscribedApps: null,
        liveError: expect.stringMatching(/disconnect it and connect it again/i),
      });
      expect(graph.callsTo('/subscribed_apps')).toHaveLength(0);
      expect(await row(created.id)).toMatchObject({
        lastError: expect.stringMatching(/disconnect it and connect it again/i),
      });
    });

    it('marks the account when Subscribe now finds the token dead, and answers Meta’s words', async () => {
      const registered = fresh('messenger');
      const created = await connect('messenger', registered);
      graph.expiredTokens.add(registered.token);

      const response = await call('POST', `${accounts(BRAND_A)}/${created.id}/subscribe`, adminA);
      graph.expiredTokens.delete(registered.token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: false,
        detail: expect.stringMatching(/token|session/i),
      });
      expect(await row(created.id)).toMatchObject({
        status: 'token_expired',
        lastError: expect.stringMatching(/token|session/i),
      });
      expect((await row(created.id)).lastError).not.toContain(registered.token);

      const status = await call('GET', `${accounts(BRAND_A)}/${created.id}/status`, adminA);
      expect(status.json()).toMatchObject({ status: 'token_expired', health: 'failing' });
    });
  });

  // ---------------------------------------------------------------- refresh

  describe('renewing an Instagram token', () => {
    const age = (id: string, days: number) =>
      owner.db
        .update(metaAccounts)
        .set({
          tokenRefreshedAt: new Date(Date.now() - days * DAY_MS),
          tokenUpdatedAt: new Date(Date.now() - days * DAY_MS),
        })
        .where(eq(metaAccounts.id, id));

    it('renews a token a week old: the new token is stored encrypted, and the expiry moves', async () => {
      const registered = fresh('instagram');
      const created = await connect('instagram', registered);
      await age(created.id, 8);
      const before = Date.now();

      const response = await call('POST', `${accounts(BRAND_A)}/${created.id}/refresh`, adminA);

      expect(response.statusCode).toBe(200);
      const stored = await row(created.id);
      const renewed = decryptSecret(stored.accessToken, keyring);
      expect(renewed).toBe(`${registered.token}.r1`);
      expect(stored.accessToken).toMatch(/^v1\./);
      expect(stored.tokenExpiresAt?.getTime()).toBeGreaterThan(before + 59 * DAY_MS);
      expect(stored.tokenRefreshedAt?.getTime()).toBeGreaterThanOrEqual(before);
      expect(response.json()).toMatchObject({ tokenHint: renewed.slice(-4) });
      expect(response.body).not.toContain(renewed);
      expect((await audits(created.id)).at(-1)).toMatchObject({ action: 'meta_account.refreshed' });
    });

    it('leaves a token younger than a week alone, and does not ask Meta', async () => {
      const created = await connect('instagram', fresh('instagram'));
      graph.calls.length = 0;
      const before = (await row(created.id)).accessToken;

      const response = await call('POST', `${accounts(BRAND_A)}/${created.id}/refresh`, adminA);

      expect(response.statusCode).toBe(200);
      expect((await row(created.id)).accessToken).toBe(before);
      expect(graph.callsTo('/refresh_access_token')).toHaveLength(0);
    });

    it('answers token-invalid when Meta refuses, and keeps Meta’s words on the row', async () => {
      const registered = fresh('instagram');
      const created = await connect('instagram', registered);
      await age(created.id, 8);
      graph.refuseRefresh = true;

      const response = await call('POST', `${accounts(BRAND_A)}/${created.id}/refresh`, adminA);
      graph.refuseRefresh = false;

      expect([response.statusCode, reasonOf(response)]).toEqual([400, 'token-invalid']);
      const stored = await row(created.id);
      expect(stored.lastError).toMatch(/cannot be refreshed|Invalid parameter/i);
      expect(stored.lastErrorAt).not.toBeNull();
      expect(decryptSecret(stored.accessToken, keyring)).toBe(registered.token);
    });

    it('says Meta could not be reached, and records nothing, when Graph is down', async () => {
      const created = await connect('instagram', fresh('instagram'));
      await age(created.id, 8);
      graph.failures.push({ status: 503, body: { error: { code: 2, message: 'Unavailable' } } });

      const response = await call('POST', `${accounts(BRAND_A)}/${created.id}/refresh`, adminA);

      expect([response.statusCode, reasonOf(response)]).toEqual([409, 'graph-unreachable']);
      expect((await row(created.id)).lastError).toBeNull();
    });

    it('is for Instagram only', async () => {
      const created = await connect('messenger', fresh('messenger'));

      const response = await call('POST', `${accounts(BRAND_A)}/${created.id}/refresh`, adminA);

      expect(response.statusCode).toBe(400);
    });
  });

  // ------------------------------------------------------------ disconnect

  describe('disconnecting', () => {
    it('removes the row, unsubscribes the app as far as Meta allows, and audits it', async () => {
      const registered = fresh('messenger');
      const created = await connect('messenger', registered);
      expect(graph.subscriptionOf(registered.id)).not.toEqual([]);

      const response = await call('DELETE', `${accounts(BRAND_A)}/${created.id}`, adminA);

      expect(response.statusCode).toBe(204);
      expect(
        await owner.db.select().from(metaAccounts).where(eq(metaAccounts.id, created.id)),
      ).toHaveLength(0);
      expect(graph.subscriptionOf(registered.id)).toEqual([]);
      expect((await audits(created.id)).at(-1)).toEqual({
        action: 'meta_account.deleted',
        actorId: ADMIN_A,
        meta: { platform: 'messenger', externalId: registered.id },
      });
      expect(await changedEvents(created.id)).toHaveLength(2);
      expect((await call('GET', `${accounts(BRAND_A)}/${created.id}`, adminA)).statusCode).toBe(
        404,
      );
    });

    it('unsubscribes a WhatsApp number on its business account, and without one skips the call', async () => {
      const subscribed = fresh('whatsapp');
      const legacy = fresh('whatsapp');
      const first = await connect('whatsapp', subscribed);
      const second = await connect('whatsapp', legacy);
      await owner.db
        .update(metaAccounts)
        .set({ wabaId: null })
        .where(eq(metaAccounts.id, second.id));
      graph.calls.length = 0;

      const removed = await call('DELETE', `${accounts(BRAND_A)}/${first.id}`, adminA);
      const removedLegacy = await call('DELETE', `${accounts(BRAND_A)}/${second.id}`, adminA);

      expect([removed.statusCode, removedLegacy.statusCode]).toEqual([204, 204]);
      expect(graph.subscriptionOf(subscribed.wabaId ?? '')).toEqual([]);
      expect(graph.callsTo('/subscribed_apps', 'DELETE').map((made) => made.path)).toEqual([
        `/${subscribed.wabaId}/subscribed_apps`,
      ]);
    });

    it('keeps the app subscribed to a business account while another of its numbers is connected, in any brand', async () => {
      const first = fresh('whatsapp', 'First number');
      const second = fresh('whatsapp', 'Second number', first.wabaId);
      const inBrandA = await connect('whatsapp', first);
      const inBrandB = await call('POST', accounts(BRAND_B), adminB, {
        platform: 'whatsapp',
        externalId: second.id,
        accessToken: second.token,
        departmentId: SUPPORT_B,
      });
      expect(inBrandB.statusCode).toBe(201);
      const wabaId = first.wabaId ?? '';
      graph.calls.length = 0;

      const removedFirst = await call('DELETE', `${accounts(BRAND_A)}/${inBrandA.id}`, adminA);

      // The second number still posts through the same subscription.
      expect(removedFirst.statusCode).toBe(204);
      expect(graph.callsTo('/subscribed_apps', 'DELETE')).toHaveLength(0);
      expect(graph.subscriptionOf(wabaId)).toEqual(['messages']);

      const removedSecond = await call(
        'DELETE',
        `${accounts(BRAND_B)}/${inBrandB.json<{ id: string }>().id}`,
        adminB,
      );

      expect(removedSecond.statusCode).toBe(204);
      expect(graph.callsTo('/subscribed_apps', 'DELETE').map((made) => made.path)).toEqual([
        `/${wabaId}/subscribed_apps`,
      ]);
      expect(graph.subscriptionOf(wabaId)).toEqual([]);
    });

    it('disconnects an account whose token Meta has revoked, and frees its id', async () => {
      const registered = fresh('whatsapp');
      const created = await connect('whatsapp', registered);
      graph.expiredTokens.add(registered.token);

      const response = await call('DELETE', `${accounts(BRAND_A)}/${created.id}`, adminA);
      graph.expiredTokens.delete(registered.token);

      expect(response.statusCode).toBe(204);
      // Another brand may now connect it.
      const again = await call('POST', accounts(BRAND_B), adminB, {
        platform: 'whatsapp',
        externalId: registered.id,
        accessToken: registered.token,
        departmentId: SUPPORT_B,
      });
      expect(again.statusCode).toBe(201);
    });
  });

  // -------------------------------------------------------------- isolation

  describe('isolation between brands', () => {
    it('lets brand B neither see nor touch brand A’s accounts', async () => {
      const registered = fresh('messenger');
      const created = await connect('messenger', registered);
      const urlInB = `${accounts(BRAND_B)}/${created.id}`;

      const list = await call('GET', accounts(BRAND_B), adminB);
      const reads = await Promise.all([
        call('GET', urlInB, adminB),
        call('GET', `${urlInB}/status`, adminB),
        call('POST', `${urlInB}/test`, adminB),
        call('POST', `${urlInB}/subscribe`, adminB),
        call('PUT', urlInB, adminB, {
          displayName: 'Mine now',
          departmentId: SUPPORT_B,
          humanAgentEnabled: false,
        }),
        call('DELETE', urlInB, adminB),
      ]);

      expect(list.json<{ accounts: { id: string }[] }>().accounts.map((a) => a.id)).not.toContain(
        created.id,
      );
      expect(reads.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
      expect(await row(created.id)).toMatchObject({ brandId: BRAND_A, displayName: 'Helpdock' });
      expect(graph.subscriptionOf(registered.id)).not.toEqual([]);
    });
  });

  // ------------------------------------------------------------ System page

  describe('the System page’s Channels card', () => {
    it('lists each account of every brand with its platform, name and health, and no token', async () => {
      const page = await connect('messenger', fresh('messenger', 'Card Page'));
      const number = await connect('whatsapp', fresh('whatsapp', 'Card Number'));
      const instagram = await connect('instagram', fresh('instagram', 'Card Gram'));
      await owner.db
        .update(metaAccounts)
        .set({ status: 'token_expired' })
        .where(eq(metaAccounts.id, instagram.id));
      await owner.db
        .update(metaAccounts)
        .set({ lastEventAt: new Date() })
        .where(eq(metaAccounts.id, page.id));

      const statuses = await readChannelStatuses(runtime.db, new Date());
      const byId = new Map(statuses.map((status) => [status.id, status]));

      expect(byId.get(page.id)).toMatchObject({
        kind: 'messenger',
        name: 'Card Page',
        status: 'ok',
        detail: 'healthy',
      });
      expect(byId.get(number.id)).toMatchObject({
        kind: 'whatsapp',
        name: number.displayPhone,
        status: 'ok',
        detail: 'waiting',
      });
      expect(byId.get(instagram.id)).toMatchObject({
        kind: 'instagram',
        name: `@${instagram.username as string}`,
        status: 'error',
        detail: 'token expired',
      });
      expect(JSON.stringify(statuses)).not.toMatch(/Token0000/);
    });
  });
});

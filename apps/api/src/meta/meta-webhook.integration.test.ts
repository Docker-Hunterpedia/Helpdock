import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FakeGraph,
  fixtureMid,
  fixtureWamid,
  GraphClient,
  instagramText,
  type MetaEvent,
  type MetaWebhookBody,
  MetaWebhookDriver,
  metaExternalId,
  pageText,
  whatsappText,
} from '@helpdock/channels';
import { createKeyring, type Env, encryptSecret } from '@helpdock/config';
import {
  auditLog,
  brands,
  contacts,
  createDb,
  type DbHandle,
  type DbTransaction,
  departments,
  type MetaAccount,
  metaAccounts,
  metaConversations,
  metaDeliveries,
  SESSION_SETTINGS,
  seedBrandStatuses,
  ticketMessages,
  ticketStatuses,
  tickets,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type { MetaPlatform, Principal } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { MetaRepository } from './meta.repository.js';
import type { MetaEventOutcome, PlatformInboundService } from './meta-inbound.service.js';

/**
 * M10-02 against real Postgres and Redis, with the stand-in for Graph and the
 * signed-webhook driver of M10-01.
 *
 * 1. **The handshake**: the verify token answers the challenge; nothing else does.
 * 2. **The webhook**: a signed batch with entries of two brands reaches the
 *    inbound service once per entry, each inside its brand; a redelivered batch
 *    is deduped; a bad or tampered signature is 401 and files nothing; the
 *    Instagram app secret is accepted once one is set; a brand in its deletion
 *    grace is answered 200 and nothing is filed for it; two concurrent
 *    deliveries of one batch end with one record.
 * 3. **The repository**: the queries the inbound services, the reply job and the
 *    admin routes will share, against the schema they were written for.
 * 4. **The App card**: `install:admin` routes for the verify token.
 *
 * The inbound services are M10-03 to M10-05's. Here each platform's is a
 * double that files one `ticket_messages` row per customer message, which is
 * what the dedupe key and the race are about.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;

const APP_SECRET = 'integration-app-secret';
const INSTAGRAM_SECRET = 'integration-instagram-secret';
const VERIFY_TOKEN = 'integration-verify-token';

const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const INSTALL_ADMIN = uuidv7();

const NUMBER_A = '106540352242922';
const NUMBER_B = '106540352242999';
const PAGE_A = '112233445566778';
const IG_A = '17841400000000000';

const installAdmin: Principal = {
  type: 'staff',
  id: INSTALL_ADMIN,
  brands: {},
  installAdmin: true,
};
const brandAgent: Principal = {
  type: 'staff',
  id: uuidv7(),
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
    'Skipping the M10-02 Meta webhook integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Seeded {
  readonly departmentId: string;
  readonly ticketId: string;
  readonly accounts: Readonly<Record<string, MetaAccount>>;
}

/** What the double inbound service saw, and where it ran. */
interface HandlerCall {
  readonly platform: MetaPlatform;
  readonly accountId: string;
  readonly kind: MetaEvent['kind'];
  readonly messageId: string | null;
  /** `app.brand_ids` and `app.principal_id` of the transaction it was handed. */
  readonly brandIds: string;
  readonly principalId: string;
}

describe.skipIf(!hasDocker)('the Meta webhook (M10-02)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  const graph = new FakeGraph();
  const repository = new MetaRepository();
  const seeded = new Map<string, Seeded>();
  let driver: MetaWebhookDriver;

  const handlerCalls: HandlerCall[] = [];
  const state = { explode: false, raceParties: 0 };
  let raceWaiting: (() => void)[] = [];

  /** Holds each caller until `parties` have arrived: both are past the dedupe check. */
  const rendezvous = (parties: number): Promise<void> =>
    new Promise((resolve) => {
      raceWaiting.push(resolve);
      if (raceWaiting.length >= parties) {
        for (const release of raceWaiting) {
          release();
        }
        raceWaiting = [];
      }
    });

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

  /** One `ticket_messages` row per customer message, under the dedupe key. */
  const fileMessage = async (
    tx: DbTransaction,
    account: MetaAccount,
    event: Extract<MetaEvent, { kind: 'message' }>,
  ): Promise<void> => {
    const brand = seeded.get(account.brandId);
    if (brand === undefined) {
      throw new Error('the double was handed an account of a brand the suite did not seed');
    }
    const [next] = await tx.execute<{ next: number }>(
      sql`select coalesce(max(seq), 0)::int + 1 as next from ticket_messages where ticket_id = ${brand.ticketId}`,
    );
    await tx.insert(ticketMessages).values({
      brandId: account.brandId,
      ticketId: brand.ticketId,
      departmentId: brand.departmentId,
      seq: next?.next ?? 1,
      kind: 'public',
      authorType: 'contact',
      bodyHtml: `<p>${event.text}</p>`,
      bodyText: event.text,
      channel: account.platform,
      externalMessageId: metaExternalId(account.platform, event.messageId),
    });
  };

  const double = (platform: MetaPlatform): PlatformInboundService => ({
    handle: async ({ tx, account }, event): Promise<MetaEventOutcome> => {
      const [settings] = await tx.execute<{ brand_ids: string; principal_id: string }>(
        sql`select current_setting(${SESSION_SETTINGS.brandIds}, true) as brand_ids,
                   current_setting(${SESSION_SETTINGS.principalId}, true) as principal_id`,
      );
      handlerCalls.push({
        platform,
        accountId: account.id,
        kind: event.kind,
        messageId: 'messageId' in event ? event.messageId : null,
        brandIds: settings?.brand_ids ?? '',
        principalId: settings?.principal_id ?? '',
      });
      if (event.kind !== 'message') {
        return { outcome: 'handled' };
      }
      if (state.raceParties > 0) {
        await rendezvous(state.raceParties);
      }
      await fileMessage(tx, account, event);
      if (state.explode && event.text.includes('explode')) {
        throw new Error('handler failed');
      }
      return { outcome: 'handled' };
    },
  });

  const filedMessages = (brandId: string, messageId: string, platform: MetaPlatform) =>
    owner.db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.brandId, brandId),
          eq(ticketMessages.channel, platform),
          eq(ticketMessages.externalMessageId, messageId),
        ),
      );

  const accountRow = async (id: string): Promise<MetaAccount> => {
    const [row] = await owner.db.select().from(metaAccounts).where(eq(metaAccounts.id, id));
    if (row === undefined) {
      throw new Error('the account is gone');
    }
    return row;
  };

  const accountOf = (brandId: string, platform: MetaPlatform): MetaAccount => {
    const found = Object.values(seeded.get(brandId)?.accounts ?? {}).find(
      (account) => account.platform === platform,
    );
    if (found === undefined) {
      throw new Error(`no ${platform} account seeded for the brand`);
    }
    return found;
  };

  const inBrand = <T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withSystem(runtime.db, brandId, fn);

  const seedBrand = async (
    keyring: ReturnType<typeof createKeyring>,
    id: string,
    prefix: string,
    accounts: readonly { platform: MetaPlatform; externalId: string }[],
  ): Promise<void> => {
    await runtime.db.insert(brands).values({ id, name: prefix, prefix });
    await inBrand(id, async (tx) => {
      await seedBrandStatuses(tx, id);
      const [department] = await tx
        .insert(departments)
        .values({ brandId: id, name: 'Support' })
        .returning({ id: departments.id });
      const [open] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.name, 'Open'));
      const departmentId = department?.id ?? '';
      const statusId = open?.id ?? '';
      const ticketId = uuidv7();
      await tx.insert(tickets).values({
        id: ticketId,
        brandId: id,
        departmentId,
        number: 1,
        prefix,
        subject: 'Where is my order?',
        statusId,
        channel: 'whatsapp',
      });
      const rows = await tx
        .insert(metaAccounts)
        .values(
          accounts.map(({ platform, externalId }) => ({
            brandId: id,
            platform,
            departmentId,
            externalId,
            displayName: `${prefix} ${platform}`,
            accessToken: encryptSecret('EAAGintegrationtoken', keyring),
            tokenKind: platform === 'whatsapp' ? ('system_user' as const) : ('page' as const),
            tokenUpdatedAt: new Date(),
          })),
        )
        .returning();
      seeded.set(id, {
        departmentId,
        ticketId,
        accounts: Object.fromEntries(rows.map((row) => [row.id, row])),
      });
    });
  };

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
        inbound: {
          whatsapp: double('whatsapp'),
          messenger: double('messenger'),
          instagram: double('instagram'),
        },
      },
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    driver = new MetaWebhookDriver({ target: app, secret: APP_SECRET });

    const keyring = createKeyring(envFor());
    await seedBrand(keyring, BRAND_A, 'ACME', [
      { platform: 'whatsapp', externalId: NUMBER_A },
      { platform: 'messenger', externalId: PAGE_A },
      { platform: 'instagram', externalId: IG_A },
    ]);
    await seedBrand(keyring, BRAND_B, 'GLOBEX', [{ platform: 'whatsapp', externalId: NUMBER_B }]);
    await runtime.db
      .insert(users)
      .values({ id: INSTALL_ADMIN, email: 'lina@example.com', name: 'Lina Haddad' });

    await runtime.settings.set('meta.appSecret', APP_SECRET, { updatedBy: 'suite' });
    await runtime.settings.set('meta.webhookVerifyToken', VERIFY_TOKEN, { updatedBy: 'suite' });
  }, 300_000);

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await graph.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(() => {
    handlerCalls.length = 0;
    state.explode = false;
    state.raceParties = 0;
    raceWaiting = [];
    graph.reset();
  });

  // ------------------------------------------------------------- handshake

  describe('the handshake', () => {
    it('echoes the challenge as plain text for the install’s verify token', async () => {
      const response = await driver.handshake({
        verifyToken: VERIFY_TOKEN,
        challenge: '1158201444',
      });

      expect(response).toEqual({ status: 200, body: '1158201444' });
      const raw = await app.inject({
        method: 'GET',
        url: '/api/meta/webhook?hub.mode=subscribe&hub.verify_token=integration-verify-token&hub.challenge=77',
      });
      expect(raw.headers['content-type']).toMatch(/^text\/plain/);
    });

    it('answers 403 to a wrong token, a wrong mode and a missing challenge', async () => {
      expect((await driver.handshake({ verifyToken: 'wrong', challenge: '1' })).status).toBe(403);
      expect(
        (await driver.handshake({ verifyToken: VERIFY_TOKEN, challenge: '1', mode: 'unsubscribe' }))
          .status,
      ).toBe(403);
      const noChallenge = await app.inject({
        method: 'GET',
        url: `/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`,
      });
      expect(noChallenge.statusCode).toBe(403);
    });

    it('does not echo a challenge that could split a header or run as markup', async () => {
      const response = await driver.handshake({
        verifyToken: VERIFY_TOKEN,
        challenge: '<script>alert(1)</script>\r\nx-injected: 1',
      });

      expect(response.status).toBe(403);
      expect(response.body).not.toContain('script');
    });
  });

  // --------------------------------------------------------------- webhook

  describe('a signed delivery', () => {
    it('reaches the inbound service once per entry, each inside its own brand', async () => {
      const wamidA = fixtureWamid(101);
      const wamidB = fixtureWamid(102);
      const wamidA2 = fixtureWamid(103);

      const response = await driver.postBatch([
        whatsappText({ phoneNumberId: NUMBER_A, wamid: wamidA, text: 'one for Acme' }),
        whatsappText({ phoneNumberId: NUMBER_B, wamid: wamidB, text: 'one for Globex' }),
        whatsappText({ phoneNumberId: NUMBER_A, wamid: wamidA2, text: 'two for Acme' }),
      ]);

      expect(response).toEqual({ status: 200, body: '{"ok":true}' });
      const accountA = accountOf(BRAND_A, 'whatsapp');
      const accountB = accountOf(BRAND_B, 'whatsapp');
      // Two entries (accounts), three events: the two Acme messages are one entry.
      expect(handlerCalls.map((call) => [call.accountId, call.messageId])).toEqual([
        [accountA.id, wamidA],
        [accountA.id, wamidA2],
        [accountB.id, wamidB],
      ]);
      for (const call of handlerCalls) {
        const brandId = call.accountId === accountA.id ? BRAND_A : BRAND_B;
        const other = brandId === BRAND_A ? BRAND_B : BRAND_A;
        expect(call.brandIds).toBe(`{${brandId}}`);
        expect(call.brandIds).not.toContain(other);
        expect(call.principalId).toBe('meta.webhook');
      }
      expect(await filedMessages(BRAND_A, wamidA, 'whatsapp')).toHaveLength(1);
      expect(await filedMessages(BRAND_A, wamidA2, 'whatsapp')).toHaveLength(1);
      expect(await filedMessages(BRAND_B, wamidB, 'whatsapp')).toHaveLength(1);
      // Each row is in the brand whose account it came in on, and in no other.
      expect(await filedMessages(BRAND_B, wamidA, 'whatsapp')).toHaveLength(0);
      expect(await filedMessages(BRAND_A, wamidB, 'whatsapp')).toHaveLength(0);
    });

    it('moves the account’s last event and never calls Graph', async () => {
      const account = accountOf(BRAND_A, 'whatsapp');
      const before = (await accountRow(account.id)).lastEventAt;

      await driver.post(whatsappText({ phoneNumberId: NUMBER_A, wamid: fixtureWamid(110) }));

      const after = (await accountRow(account.id)).lastEventAt;
      expect(after).not.toBeNull();
      expect(after?.getTime() ?? 0).toBeGreaterThan(before?.getTime() ?? 0);
      expect(graph.calls).toEqual([]);
    });

    it('routes by object: a Page to the Messenger service, an Instagram account to Instagram’s', async () => {
      const mid = fixtureMid(120);
      const igMid = fixtureMid(121);

      expect((await driver.post(pageText({ pageId: PAGE_A, mid, text: 'hi page' }))).status).toBe(
        200,
      );
      expect(
        (
          await driver.post(instagramText({ igAccountId: IG_A, mid: igMid, text: 'hi ig' }), {
            secret: APP_SECRET,
          })
        ).status,
      ).toBe(200);

      expect(handlerCalls.map((call) => [call.platform, call.messageId])).toEqual([
        ['messenger', mid],
        ['instagram', igMid],
      ]);
      expect(await filedMessages(BRAND_A, mid, 'messenger')).toHaveLength(1);
      expect(await filedMessages(BRAND_A, igMid, 'instagram')).toHaveLength(1);
    });

    it('is a 200 for an account it does not know, and files nothing', async () => {
      const wamid = fixtureWamid(130);

      const response = await driver.post(whatsappText({ phoneNumberId: '999999999999', wamid }));

      expect(response.status).toBe(200);
      expect(handlerCalls).toEqual([]);
      expect(await filedMessages(BRAND_A, wamid, 'whatsapp')).toHaveLength(0);
    });

    it('is a 200 for the same id on another platform: a Page is not a phone number', async () => {
      const response = await driver.post(pageText({ pageId: NUMBER_A, mid: fixtureMid(131) }));

      expect(response.status).toBe(200);
      expect(handlerCalls).toEqual([]);
    });

    it('does not show the inbound service a message it already filed', async () => {
      const wamids = [fixtureWamid(140), fixtureWamid(141)];
      const batch = [
        whatsappText({ phoneNumberId: NUMBER_A, wamid: wamids[0] ?? '', text: 'a' }),
        whatsappText({ phoneNumberId: NUMBER_B, wamid: wamids[1] ?? '', text: 'b' }),
      ];

      expect((await driver.postBatch(batch)).status).toBe(200);
      expect(handlerCalls).toHaveLength(2);

      handlerCalls.length = 0;
      expect((await driver.postBatch(batch)).status).toBe(200);

      expect(handlerCalls).toEqual([]);
      expect(await filedMessages(BRAND_A, wamids[0] ?? '', 'whatsapp')).toHaveLength(1);
      expect(await filedMessages(BRAND_B, wamids[1] ?? '', 'whatsapp')).toHaveLength(1);
    });

    it('hands a status report to the service every time: only a message has a dedupe key', async () => {
      const report = driver.statusFor({ phoneNumberId: NUMBER_A, wamid: fixtureWamid(150) });

      await driver.post(report);
      await driver.post(report);

      expect(handlerCalls.map((call) => call.kind)).toEqual(['status', 'status']);
    });
  });

  describe('a delivery that is not Meta’s', () => {
    const body = (): MetaWebhookBody =>
      whatsappText({ phoneNumberId: NUMBER_A, wamid: fixtureWamid(160), text: 'hello' });

    const nothingFiled = async (): Promise<void> => {
      expect(handlerCalls).toEqual([]);
      expect(await filedMessages(BRAND_A, fixtureWamid(160), 'whatsapp')).toHaveLength(0);
    };

    it('is 401 for a wrong secret, and files nothing', async () => {
      const response = await driver.post(body(), { secret: 'not-the-app-secret' });

      expect(response.status).toBe(401);
      await nothingFiled();
    });

    it('is 401 for a missing header and for one that is not a signature', async () => {
      expect((await driver.post(body(), { header: null })).status).toBe(401);
      expect((await driver.post(body(), { header: 'sha256=not-hex' })).status).toBe(401);
      expect((await driver.post(body(), { header: 'sha1=abcdef' })).status).toBe(401);
      await nothingFiled();
    });

    it('is 401 for a body changed after it was signed', async () => {
      const response = await driver.post(body(), {
        tamper: (raw) => Buffer.from(raw.toString('utf8').replace('hello', 'hellp'), 'utf8'),
      });

      expect(response.status).toBe(401);
      await nothingFiled();
    });

    it('is 401 for a body re-serialised with the same content, because the signature covers the bytes', async () => {
      const response = await driver.post(body(), {
        tamper: (raw) => Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2)),
      });

      expect(response.status).toBe(401);
      await nothingFiled();
    });

    it('is 400 for a signed body that is not a Meta webhook, and files nothing', async () => {
      const response = await driver.post({ object: 'something_else', entry: [] });

      expect(response.status).toBe(400);
      await nothingFiled();
    });

    it('leaves the account’s health line alone', async () => {
      const account = accountOf(BRAND_A, 'whatsapp');
      const before = await accountRow(account.id);

      await driver.post(body(), { secret: 'wrong' });

      const after = await accountRow(account.id);
      expect(after.lastEventAt).toEqual(before.lastEventAt);
      expect(after.lastError).toEqual(before.lastError);
    });
  });

  describe('the Instagram app secret', () => {
    it('is refused until one is set, and accepted once it is', async () => {
      const body = () => instagramText({ igAccountId: IG_A, mid: fixtureMid(170), text: 'secret' });

      expect((await driver.post(body(), { secret: INSTAGRAM_SECRET })).status).toBe(401);
      expect(handlerCalls).toEqual([]);

      await runtime.settings.set('meta.instagramAppSecret', INSTAGRAM_SECRET, {
        updatedBy: 'suite',
      });

      expect((await driver.post(body(), { secret: INSTAGRAM_SECRET })).status).toBe(200);
      expect(handlerCalls.map((call) => call.platform)).toEqual(['instagram']);
      // The app secret still signs Instagram’s webhooks, and a third secret still does not.
      expect(
        (
          await driver.post(
            instagramText({ igAccountId: IG_A, mid: fixtureMid(171), text: 'app secret' }),
          )
        ).status,
      ).toBe(200);
      expect((await driver.post(body(), { secret: 'a-third-secret' })).status).toBe(401);
    });
  });

  describe('a brand in its deletion grace', () => {
    const setStatus = (status: 'active' | 'deleting') =>
      owner.db
        .update(brands)
        .set({ status, deletedAt: status === 'active' ? null : new Date() })
        .where(eq(brands.id, BRAND_B));

    it('is answered 200, so Meta neither redelivers nor unsubscribes, and nothing is filed for it', async () => {
      await setStatus('deleting');
      try {
        const wamid = fixtureWamid(180);

        const response = await driver.post(whatsappText({ phoneNumberId: NUMBER_B, wamid }));

        expect(response.status).toBe(200);
        expect(handlerCalls).toEqual([]);
        expect(await filedMessages(BRAND_B, wamid, 'whatsapp')).toHaveLength(0);
      } finally {
        await setStatus('active');
      }
    });

    it('does not cost a live brand the events it shares a batch with', async () => {
      await setStatus('deleting');
      try {
        const live = fixtureWamid(181);
        const gone = fixtureWamid(182);

        const response = await driver.postBatch([
          whatsappText({ phoneNumberId: NUMBER_A, wamid: live }),
          whatsappText({ phoneNumberId: NUMBER_B, wamid: gone }),
        ]);

        expect(response.status).toBe(200);
        expect(await filedMessages(BRAND_A, live, 'whatsapp')).toHaveLength(1);
        expect(await filedMessages(BRAND_B, gone, 'whatsapp')).toHaveLength(0);
      } finally {
        await setStatus('active');
      }
    });

    it('is answered normally again when the brand is restored', async () => {
      await setStatus('deleting');
      await setStatus('active');

      const response = await driver.post(
        whatsappText({ phoneNumberId: NUMBER_B, wamid: fixtureWamid(183) }),
      );

      expect(response.status).toBe(200);
      expect(handlerCalls).toHaveLength(1);
    });
  });

  describe('two deliveries of one batch at once', () => {
    it('end with one record, and both are answered 200', async () => {
      state.raceParties = 2;
      const wamid = fixtureWamid(190);
      const body = whatsappText({ phoneNumberId: NUMBER_A, wamid, text: 'raced' });

      const [first, second] = await Promise.all([driver.post(body), driver.post(body)]);

      // Both got past the dedupe check before either filed: the unique index decided.
      expect(handlerCalls.filter((call) => call.messageId === wamid)).toHaveLength(2);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await filedMessages(BRAND_A, wamid, 'whatsapp')).toHaveLength(1);
    });
  });

  describe('a route that fails', () => {
    it('is rolled back whole, answered 500 so Meta redelivers, and filed by the redelivery', async () => {
      state.explode = true;
      const account = accountOf(BRAND_A, 'whatsapp');
      const wamid = fixtureWamid(200);
      const body = whatsappText({ phoneNumberId: NUMBER_A, wamid, text: 'explode please' });

      const first = await driver.post(body);

      expect(first.status).toBe(500);
      expect(await filedMessages(BRAND_A, wamid, 'whatsapp')).toHaveLength(0);
      const failing = await accountRow(account.id);
      expect(failing.lastError).toBe('Error: handler failed');
      expect(failing.lastErrorAt).not.toBeNull();

      state.explode = false;
      const second = await driver.post(body);

      expect(second.status).toBe(200);
      expect(await filedMessages(BRAND_A, wamid, 'whatsapp')).toHaveLength(1);
    });

    it('does not refuse the other brands in the batch', async () => {
      state.explode = true;
      const bad = fixtureWamid(201);
      const good = fixtureWamid(202);

      const response = await driver.postBatch([
        whatsappText({ phoneNumberId: NUMBER_A, wamid: bad, text: 'explode' }),
        whatsappText({ phoneNumberId: NUMBER_B, wamid: good, text: 'fine' }),
      ]);

      expect(response.status).toBe(200);
      expect(await filedMessages(BRAND_A, bad, 'whatsapp')).toHaveLength(0);
      expect(await filedMessages(BRAND_B, good, 'whatsapp')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------- App card

  describe('the App card (install:admin)', () => {
    it('refuses a brand’s agent', async () => {
      const read = await app.inject({
        method: 'GET',
        url: '/api/meta/app',
        headers: asPrincipal(brandAgent),
      });
      const rotate = await app.inject({
        method: 'POST',
        url: '/api/meta/app/verify-token',
        headers: asPrincipal(brandAgent),
      });
      const anonymous = await app.inject({ method: 'GET', url: '/api/meta/app' });

      expect([read.statusCode, rotate.statusCode, anonymous.statusCode]).toEqual([403, 403, 401]);
    });

    it('shows where Meta posts and whether each secret is set, and no secret', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/meta/app',
        headers: asPrincipal(installAdmin),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        appIdSet: false,
        appId: '',
        appSecretSet: true,
        instagramAppSecretSet: false,
        graphVersion: 'v25.0',
        callbackUrl: 'https://support.example.com/api/meta/webhook',
        verifyTokenHint: VERIFY_TOKEN.slice(-4),
        secretsLockedByEnv: [],
      });
      expect(response.body).not.toContain(APP_SECRET);
      expect(response.body).not.toContain(INSTAGRAM_SECRET);
    });

    it('shows a new verify token once, audited without it, and the old one stops answering', async () => {
      const rotated = await app.inject({
        method: 'POST',
        url: '/api/meta/app/verify-token',
        headers: asPrincipal(installAdmin),
      });

      expect(rotated.statusCode).toBe(200);
      const { verifyToken } = rotated.json<{ verifyToken: string }>();
      expect(verifyToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect((await driver.handshake({ verifyToken: VERIFY_TOKEN, challenge: '1' })).status).toBe(
        403,
      );
      expect((await driver.handshake({ verifyToken, challenge: '2' })).status).toBe(200);

      const audit = await owner.db
        .select({ action: auditLog.action, meta: auditLog.meta })
        .from(auditLog)
        .where(and(eq(auditLog.targetType, 'settings'), eq(auditLog.targetId, 'meta')));
      expect(audit).toEqual([
        { action: 'settings.updated', meta: { keys: ['meta.webhookVerifyToken'] } },
      ]);
      expect(JSON.stringify(audit)).not.toContain(verifyToken);

      await runtime.settings.set('meta.webhookVerifyToken', VERIFY_TOKEN, { updatedBy: 'suite' });
    });
  });

  // ------------------------------------------------------------ repository

  describe('MetaRepository', () => {
    const NOW = new Date('2026-10-11T08:00:00.000Z');
    const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
    let sequence = 100;

    const addContact = (brandId: string): Promise<string> =>
      inBrand(brandId, async (tx) => {
        const [row] = await tx
          .insert(contacts)
          .values({ brandId, name: 'Sheena Nelson' })
          .returning({ id: contacts.id });
        return row?.id ?? '';
      });

    /** A ticket message to hang a delivery on, and the delivery itself. */
    const addDelivery = (
      brandId: string,
      account: MetaAccount,
      conversation: { id: string; customerId: string },
    ): Promise<string> =>
      inBrand(brandId, async (tx) => {
        const brand = seeded.get(brandId);
        sequence += 1;
        const [message] = await tx
          .insert(ticketMessages)
          .values({
            brandId,
            ticketId: brand?.ticketId ?? '',
            departmentId: brand?.departmentId ?? '',
            seq: sequence,
            kind: 'public',
            authorType: 'staff',
            bodyHtml: '<p>reply</p>',
            bodyText: 'reply',
            channel: account.platform,
          })
          .returning({ id: ticketMessages.id });
        const delivery = await repository.insertDelivery(tx, {
          brandId,
          departmentId: brand?.departmentId ?? '',
          ticketId: brand?.ticketId ?? '',
          ticketMessageId: message?.id ?? '',
          accountId: account.id,
          conversationId: conversation.id,
          customerId: conversation.customerId,
        });
        return delivery?.id ?? '';
      });

    describe('accounts', () => {
      it('locates an account across brands by platform and external id', async () => {
        const accountB = accountOf(BRAND_B, 'whatsapp');

        await expect(repository.locate(runtime.db, 'whatsapp', NUMBER_B)).resolves.toEqual({
          id: accountB.id,
          brandId: BRAND_B,
          platform: 'whatsapp',
          externalId: NUMBER_B,
        });
        await expect(repository.locate(runtime.db, 'messenger', PAGE_A)).resolves.toMatchObject({
          brandId: BRAND_A,
        });
      });

      it('knows a phone number from a Page that happens to share its id, and an unknown id from neither', async () => {
        await expect(repository.locate(runtime.db, 'messenger', NUMBER_A)).resolves.toBeUndefined();
        await expect(repository.locate(runtime.db, 'whatsapp', 'nope')).resolves.toBeUndefined();
      });

      it('finds a brand in its deletion grace, and leaves the refusing to the caller', async () => {
        await owner.db
          .update(brands)
          .set({ status: 'deleting', deletedAt: new Date() })
          .where(eq(brands.id, BRAND_B));
        try {
          await expect(repository.locate(runtime.db, 'whatsapp', NUMBER_B)).resolves.toMatchObject({
            brandId: BRAND_B,
          });
        } finally {
          await owner.db
            .update(brands)
            .set({ status: 'active', deletedAt: null })
            .where(eq(brands.id, BRAND_B));
        }
      });

      it('lists every account of every brand for the worker', async () => {
        const all = await repository.listAll(runtime.db, 'meta.suite');

        expect(all.map((row) => row.externalId).sort()).toEqual(
          [NUMBER_A, NUMBER_B, PAGE_A, IG_A].sort(),
        );
      });

      it('refuses to connect an account another brand already holds, without saying whose', async () => {
        const rows = await inBrand(BRAND_A, (tx) =>
          repository.insert(tx, {
            brandId: BRAND_A,
            platform: 'whatsapp',
            departmentId: seeded.get(BRAND_A)?.departmentId ?? '',
            externalId: NUMBER_B,
            displayName: 'Stolen',
            accessToken: 'v1.x',
            tokenKind: 'system_user',
            tokenUpdatedAt: new Date(),
          }),
        );

        expect(rows).toBeUndefined();
      });

      it('shows a brand its own accounts only', async () => {
        const accountB = accountOf(BRAND_B, 'whatsapp');

        await inBrand(BRAND_A, async (tx) => {
          const list = await repository.list(tx);
          expect(list.every((row) => row.account.brandId === BRAND_A)).toBe(true);
          expect(list.map((row) => row.departmentName)).toEqual(['Support', 'Support', 'Support']);
          await expect(repository.account(tx, accountB.id)).resolves.toBeUndefined();
          await expect(repository.find(tx, accountB.id)).resolves.toBeUndefined();
        });
      });

      it('records the last event and the last error apart, and never lets an error grow past the cap', async () => {
        const account = accountOf(BRAND_A, 'instagram');

        await inBrand(BRAND_A, async (tx) => {
          await repository.markEvent(tx, account.id, at(1));
          await repository.markError(tx, account.id, 'x'.repeat(1_000), at(2));
        });

        const row = await accountRow(account.id);
        expect(row.lastEventAt).toEqual(at(1));
        expect(row.lastErrorAt).toEqual(at(2));
        expect(row.lastError).toHaveLength(300);
      });
      it('connects, edits, finds and disconnects an account inside its brand', async () => {
        const departmentId = seeded.get(BRAND_B)?.departmentId ?? '';

        await inBrand(BRAND_B, async (tx) => {
          const created = await repository.insert(tx, {
            brandId: BRAND_B,
            platform: 'messenger',
            departmentId,
            externalId: 'page-temp',
            displayName: 'Temp',
            accessToken: 'v1.key.sealed',
            tokenKind: 'page',
            tokenUpdatedAt: new Date(),
          });
          expect(created).toMatchObject({ status: 'connected', humanAgentEnabled: false });
          const id = created?.id ?? '';

          await expect(repository.departmentExists(tx, departmentId)).resolves.toBe(true);
          await expect(repository.departmentExists(tx, uuidv7())).resolves.toBe(false);

          const updated = await repository.update(tx, id, {
            displayName: 'Renamed',
            humanAgentEnabled: true,
            status: 'token_expired',
          });
          expect(updated).toMatchObject({
            displayName: 'Renamed',
            humanAgentEnabled: true,
            status: 'token_expired',
          });
          await expect(repository.find(tx, id)).resolves.toMatchObject({
            account: { id, displayName: 'Renamed' },
            departmentName: 'Support',
            tokenUpdatedByName: null,
          });

          await expect(repository.delete(tx, id)).resolves.toMatchObject({ id });
          await expect(repository.find(tx, id)).resolves.toBeUndefined();
          await expect(repository.update(tx, id, { displayName: 'x' })).resolves.toBeUndefined();
          await expect(repository.delete(tx, id)).resolves.toBeUndefined();
        });
      });
    });

    describe('conversations', () => {
      it('opens the reply window at the customer’s message and moves it forward only', async () => {
        const account = accountOf(BRAND_A, 'whatsapp');
        const contactId = await addContact(BRAND_A);
        const customerId = 'US.1000000000000000001';
        const base = { brandId: BRAND_A, accountId: account.id, customerId, contactId };

        await inBrand(BRAND_A, async (tx) => {
          const opened = await repository.upsertConversation(tx, {
            ...base,
            waId: '16505551234',
            profileName: 'Sheena',
            username: null,
            inbound: { at: at(10), messageId: 'wamid.ten' },
          });
          expect(opened).toMatchObject({
            lastInboundAt: at(10),
            lastInboundMessageId: 'wamid.ten',
            waId: '16505551234',
            profileName: 'Sheena',
          });

          const later = await repository.upsertConversation(tx, {
            ...base,
            waId: null,
            profileName: null,
            username: null,
            inbound: { at: at(20), messageId: 'wamid.twenty' },
          });
          expect(later).toMatchObject({
            id: opened.id,
            lastInboundAt: at(20),
            lastInboundMessageId: 'wamid.twenty',
            // A null leaves what Meta said before.
            waId: '16505551234',
            profileName: 'Sheena',
          });

          const late = await repository.upsertConversation(tx, {
            ...base,
            waId: null,
            profileName: 'Sheena N.',
            username: null,
            inbound: { at: at(15), messageId: 'wamid.fifteen' },
          });
          // Delivered out of order: the newer message keeps the window it opened.
          expect(late).toMatchObject({
            lastInboundAt: at(20),
            lastInboundMessageId: 'wamid.twenty',
            profileName: 'Sheena N.',
          });
        });
      });

      it('leaves the window alone for a write that is not a customer’s message', async () => {
        const account = accountOf(BRAND_A, 'messenger');
        const contactId = await addContact(BRAND_A);
        const base = {
          brandId: BRAND_A,
          accountId: account.id,
          customerId: `${PAGE_A}-psid-1`,
          contactId,
          waId: null,
          username: null,
        };

        await inBrand(BRAND_A, async (tx) => {
          const before = await repository.upsertConversation(tx, {
            ...base,
            profileName: null,
            inbound: null,
          });
          expect(before.lastInboundAt).toBeNull();

          await repository.upsertConversation(tx, {
            ...base,
            profileName: null,
            inbound: { at: at(5), messageId: 'm_1' },
          });
          const after = await repository.upsertConversation(tx, {
            ...base,
            profileName: 'Name',
            inbound: null,
          });

          expect(after).toMatchObject({ lastInboundAt: at(5), lastInboundMessageId: 'm_1' });
        });
      });

      it('finds the conversation a ticket belongs to, else the contact’s latest', async () => {
        const account = accountOf(BRAND_A, 'instagram');
        const contactId = await addContact(BRAND_A);
        const brand = seeded.get(BRAND_A);

        await inBrand(BRAND_A, async (tx) => {
          const older = await repository.upsertConversation(tx, {
            brandId: BRAND_A,
            accountId: account.id,
            customerId: `${IG_A}-old`,
            contactId,
            waId: null,
            profileName: null,
            username: 'old',
            inbound: { at: at(1), messageId: 'm_old' },
          });
          const newer = await repository.upsertConversation(tx, {
            brandId: BRAND_A,
            accountId: account.id,
            customerId: `${IG_A}-new`,
            contactId,
            waId: null,
            profileName: null,
            username: 'new',
            inbound: { at: at(2), messageId: 'm_new' },
          });
          const ticket = { id: brand?.ticketId ?? '', contactId };

          // No conversation names the ticket yet: the contact’s latest one answers.
          await expect(repository.conversationForTicket(tx, ticket)).resolves.toMatchObject({
            id: newer.id,
          });

          await repository.setConversationTicket(tx, older.id, ticket.id);
          await expect(repository.conversationForTicket(tx, ticket)).resolves.toMatchObject({
            id: older.id,
          });
          // A ticket nobody wrote on, with no contact to fall back on, has no conversation.
          await expect(
            repository.conversationForTicket(tx, { id: uuidv7(), contactId: null }),
          ).resolves.toBeUndefined();
        });
      });
    });

    describe('deliveries', () => {
      const withConversation = async (brandId: string, account: MetaAccount) => {
        const contactId = await addContact(brandId);
        sequence += 1;
        const customerId = `cust-${String(sequence)}`;
        const conversation = await inBrand(brandId, (tx) =>
          repository.upsertConversation(tx, {
            brandId,
            accountId: account.id,
            customerId,
            contactId,
            waId: null,
            profileName: null,
            username: null,
            inbound: { at: at(0), messageId: `m_${customerId}` },
          }),
        );
        return { conversation, contactId };
      };

      it('writes one delivery per reply, and says so when asked twice', async () => {
        const account = accountOf(BRAND_A, 'whatsapp');
        const { conversation } = await withConversation(BRAND_A, account);
        const id = await addDelivery(BRAND_A, account, conversation);

        await inBrand(BRAND_A, async (tx) => {
          const row = await repository.delivery(tx, id);
          expect(row).toMatchObject({ status: 'queued', partsSent: 0, platformMessageIds: [] });
          const again = await repository.insertDelivery(tx, {
            brandId: BRAND_A,
            departmentId: row?.departmentId ?? '',
            ticketId: row?.ticketId ?? '',
            ticketMessageId: row?.ticketMessageId ?? '',
            accountId: account.id,
            conversationId: conversation.id,
            customerId: conversation.customerId,
          });
          expect(again).toBeUndefined();
        });
      });

      it('records each part as it lands, so a retry resumes after the last one', async () => {
        const account = accountOf(BRAND_A, 'whatsapp');
        const { conversation } = await withConversation(BRAND_A, account);
        const id = await addDelivery(BRAND_A, account, conversation);

        await inBrand(BRAND_A, async (tx) => {
          await repository.recordPart(tx, id, 'wamid.part1');
          await repository.recordPart(tx, id, null);
          await repository.recordPart(tx, id, 'wamid.part3');
          await repository.markSent(tx, id, at(1));

          await expect(repository.delivery(tx, id)).resolves.toMatchObject({
            status: 'sent',
            partsSent: 3,
            platformMessageIds: ['wamid.part1', 'wamid.part3'],
            sentAt: at(1),
          });
        });
      });

      it('moves delivered and read forward and never back', async () => {
        const account = accountOf(BRAND_A, 'whatsapp');
        const { conversation } = await withConversation(BRAND_A, account);
        const id = await addDelivery(BRAND_A, account, conversation);

        await inBrand(BRAND_A, async (tx) => {
          await repository.recordPart(tx, id, 'wamid.report');
          await repository.markSent(tx, id, at(1));

          // `read` arriving first still leaves a delivered time: the customer cannot read what did not arrive.
          const read = await repository.advanceStatus(tx, 'wamid.report', 'read', at(3));
          expect(read).toMatchObject({ status: 'read', deliveredAt: at(3), readAt: at(3) });

          await expect(
            repository.advanceStatus(tx, 'wamid.report', 'delivered', at(2)),
          ).resolves.toBeUndefined();
          await expect(repository.delivery(tx, id)).resolves.toMatchObject({
            status: 'read',
            deliveredAt: at(3),
            readAt: at(3),
          });
          await expect(
            repository.advanceStatus(tx, 'wamid.nobody-sent-this', 'delivered', at(4)),
          ).resolves.toBeUndefined();
        });
      });

      it('lets a report that beats “sent” win, and “sent” never takes it back', async () => {
        const account = accountOf(BRAND_A, 'whatsapp');
        const { conversation } = await withConversation(BRAND_A, account);
        const id = await addDelivery(BRAND_A, account, conversation);

        await inBrand(BRAND_A, async (tx) => {
          await repository.recordPart(tx, id, 'wamid.fast');
          await repository.advanceStatus(tx, 'wamid.fast', 'delivered', at(1));
          await repository.markSent(tx, id, at(2));

          await expect(repository.delivery(tx, id)).resolves.toMatchObject({
            status: 'delivered',
            sentAt: at(2),
            deliveredAt: at(1),
          });
        });
      });

      it('marks every delivery sent at or before a watermark and none after it', async () => {
        const account = accountOf(BRAND_A, 'messenger');
        const { conversation } = await withConversation(BRAND_A, account);
        const other = await withConversation(BRAND_A, account);
        const [first, second, third, elsewhere] = await Promise.all([
          addDelivery(BRAND_A, account, conversation),
          addDelivery(BRAND_A, account, conversation),
          addDelivery(BRAND_A, account, conversation),
          addDelivery(BRAND_A, account, other.conversation),
        ]);

        await inBrand(BRAND_A, async (tx) => {
          await repository.markSent(tx, first ?? '', at(10));
          await repository.markSent(tx, second ?? '', at(20));
          await repository.markSent(tx, third ?? '', at(40));
          await repository.markSent(tx, elsewhere ?? '', at(10));

          const delivered = await repository.advanceByWatermark(
            tx,
            conversation.id,
            'delivered',
            at(30),
          );
          expect(delivered.map((row) => row.id).sort()).toEqual([first, second].sort());

          const read = await repository.advanceByWatermark(tx, conversation.id, 'read', at(30));
          expect(read.map((row) => row.id).sort()).toEqual([first, second].sort());
          // Reading what was already read moves nothing.
          await expect(
            repository.advanceByWatermark(tx, conversation.id, 'read', at(30)),
          ).resolves.toEqual([]);

          await expect(repository.delivery(tx, third ?? '')).resolves.toMatchObject({
            status: 'sent',
          });
          // Another customer’s conversation is not the watermark’s.
          await expect(repository.delivery(tx, elsewhere ?? '')).resolves.toMatchObject({
            status: 'sent',
          });
        });
      });

      it('fails for good only when the job says so, truncates what Graph said, and can be put back', async () => {
        const account = accountOf(BRAND_A, 'whatsapp');
        const { conversation } = await withConversation(BRAND_A, account);
        const id = await addDelivery(BRAND_A, account, conversation);

        await inBrand(BRAND_A, async (tx) => {
          await repository.recordFailure(tx, id, {
            attempts: 1,
            error: 'rate limited',
            errorCode: '130429',
            dead: false,
            at: at(1),
          });
          await expect(repository.delivery(tx, id)).resolves.toMatchObject({
            status: 'queued',
            attempts: 1,
            errorCode: '130429',
          });

          await repository.recordFailure(tx, id, {
            attempts: 5,
            error: 'x'.repeat(1_000),
            errorCode: '551',
            dead: true,
            at: at(2),
          });
          const failed = await repository.delivery(tx, id);
          expect(failed).toMatchObject({ status: 'failed', attempts: 5, failedAt: at(2) });
          expect(failed?.lastError).toHaveLength(300);

          const back = await repository.requeue(tx, [id]);
          expect(back).toHaveLength(1);
          expect(back[0]).toMatchObject({
            status: 'queued',
            attempts: 0,
            lastError: null,
            errorCode: null,
            failedAt: null,
          });
          await expect(repository.requeue(tx, [id])).resolves.toEqual([]);
          await expect(repository.requeue(tx, [])).resolves.toEqual([]);
        });
      });

      it('refuses a queued delivery for good, and refuses nothing that already left', async () => {
        const account = accountOf(BRAND_A, 'whatsapp');
        const { conversation } = await withConversation(BRAND_A, account);
        const refused = await addDelivery(BRAND_A, account, conversation);
        const sent = await addDelivery(BRAND_A, account, conversation);

        await inBrand(BRAND_A, async (tx) => {
          await repository.markRefused(tx, refused, {
            errorCode: '131047',
            error: 'Re-engagement message',
            at: at(1),
          });
          await repository.markSent(tx, sent, at(1));
          await repository.markRefused(tx, sent, { errorCode: '131047', error: 'late', at: at(2) });

          await expect(repository.delivery(tx, refused)).resolves.toMatchObject({
            status: 'refused',
            errorCode: '131047',
            failedAt: at(1),
          });
          await expect(repository.delivery(tx, sent)).resolves.toMatchObject({ status: 'sent' });
          // A refusal is not something Retry puts back.
          await expect(repository.requeue(tx, [refused])).resolves.toEqual([]);
        });
      });

      it('lists a ticket’s deliveries oldest first', async () => {
        const account = accountOf(BRAND_B, 'whatsapp');
        const { conversation } = await withConversation(BRAND_B, account);
        const first = await addDelivery(BRAND_B, account, conversation);
        const second = await addDelivery(BRAND_B, account, conversation);

        await inBrand(BRAND_B, async (tx) => {
          const rows = await repository.deliveriesForTicket(
            tx,
            seeded.get(BRAND_B)?.ticketId ?? '',
          );

          expect(rows.map((row) => row.id)).toEqual([first, second]);
        });
      });

      it('reports an account’s last reply, its recent failures and refusals, and its open tickets', async () => {
        const account = accountOf(BRAND_A, 'instagram');
        const { conversation } = await withConversation(BRAND_A, account);
        const sent = await addDelivery(BRAND_A, account, conversation);
        const failed = await addDelivery(BRAND_A, account, conversation);
        const oldFailure = await addDelivery(BRAND_A, account, conversation);
        const refused = await addDelivery(BRAND_A, account, conversation);

        await inBrand(BRAND_A, async (tx) => {
          await repository.markSent(tx, sent, at(50));
          await repository.recordFailure(tx, failed, {
            attempts: 5,
            error: 'e',
            errorCode: null,
            dead: true,
            at: at(60),
          });
          await repository.recordFailure(tx, oldFailure, {
            attempts: 5,
            error: 'e',
            errorCode: null,
            dead: true,
            at: at(-60 * 48),
          });
          await repository.markRefused(tx, refused, {
            errorCode: '10',
            error: 'closed',
            at: at(61),
          });
          await repository.setConversationTicket(
            tx,
            conversation.id,
            seeded.get(BRAND_A)?.ticketId ?? '',
          );

          await expect(repository.activity(tx, account.id, at(0))).resolves.toEqual({
            lastReplyAt: at(50),
            failedSends: 1,
            refusedSends: 1,
            openTickets: 1,
          });
          // An account nobody wrote to is quiet, not an error.
          await expect(repository.activity(tx, uuidv7(), at(0))).resolves.toEqual({
            lastReplyAt: null,
            failedSends: 0,
            refusedSends: 0,
            openTickets: 0,
          });
        });
      });

      it('keeps one brand’s deliveries and conversations out of another’s view', async () => {
        const seen = await inBrand(BRAND_B, async (tx) => ({
          conversations: await tx
            .select({ brandId: metaConversations.brandId })
            .from(metaConversations),
          deliveries: await tx.select({ brandId: metaDeliveries.brandId }).from(metaDeliveries),
        }));
        const [everyone] = await owner.db
          .select({ count: sql<number>`count(*)::int` })
          .from(metaDeliveries);

        expect(seen.deliveries.length).toBeGreaterThan(0);
        expect(seen.deliveries.length).toBeLessThan(everyone?.count ?? 0);
        expect(seen.deliveries.every((row) => row.brandId === BRAND_B)).toBe(true);
        expect(seen.conversations.every((row) => row.brandId === BRAND_B)).toBe(true);
      });
    });
  });
});

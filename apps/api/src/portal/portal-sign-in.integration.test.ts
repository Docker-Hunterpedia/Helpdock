import { createHash } from 'node:crypto';
import { createKeyring, decryptSecret, type Env } from '@helpdock/config';
import {
  accounts,
  brandDomains,
  brands,
  contactIdentities,
  contacts,
  createDb,
  customerSessions,
  customerSignInTokens,
  type DbHandle,
  outbox,
  uuidv7,
  webFormSettings,
  withSystem,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL } from '../help-center/site/site.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { FakeStorage } from '../testing/media.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { PORTAL_LINK_EMAIL_RULE } from './portal-site.js';
import { SESSION_TTL_MS } from './session-rules.js';
import { createSignInEmailHandler, PORTAL_SIGN_IN_EVENT } from './sign-in-email.js';

/**
 * M21-02 against a real Postgres and Redis, through the api's own routes: the
 * sign-in flow of ADR 0059 from the form to a session, and everything that must
 * refuse. The row-level-security policies under it are M21-01's own suite.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 44).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const HOST_A = 'help.acme.test';
const HOST_B = 'help.globex.test';
const MONA = 'mona@acme.example';

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write('Skipping the M21-02 sign-in integration tests: Docker is not available.\n');
}

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly cookies: readonly {
    name: string;
    value: string;
    maxAge?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    path?: string;
  }[];
}

const jar = (...replies: Reply[]): Record<string, string> => {
  const cookies: Record<string, string> = {};
  for (const reply of replies) {
    for (const cookie of reply.cookies) {
      cookies[cookie.name] = cookie.value;
    }
  }
  return Object.fromEntries(Object.entries(cookies).filter(([, value]) => value !== ''));
};

const csrfOf = (reply: Reply): string => /name="csrf" value="([^"]+)"/.exec(reply.body)?.[1] ?? '';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe.skipIf(!hasDocker)('customer sign-in (M21-02)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let brandB: string;
  let accountId: string;
  let sequence = 0;
  const keyring = createKeyring({ APP_MASTER_KEY: MASTER_KEY });

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      DATABASE_MIGRATION_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
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
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const brandA = () => seeded.brandId;

  const setPortal = (brandId: string, portal: Record<string, unknown>) =>
    owner.db.execute(
      sql`update brands set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ portal })}::jsonb where id = ${brandId}`,
    );

  /** A request as a browser on a help center host sends it. */
  const get = async (
    host: string,
    url: string,
    cookies: Record<string, string> = {},
    ip = '203.0.113.9',
  ): Promise<Reply> => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { host },
      remoteAddress: ip,
      cookies,
    });
    return {
      status: response.statusCode,
      body: response.body,
      headers: response.headers,
      cookies: response.cookies,
    };
  };

  const post = async (
    host: string,
    url: string,
    fields: Record<string, string>,
    cookies: Record<string, string> = {},
    ip = '203.0.113.9',
    prefix = '',
  ): Promise<Reply> => {
    const response = await app.inject({
      method: 'POST',
      url: `${prefix}${url}`,
      headers: {
        host,
        origin: `https://${host}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      remoteAddress: ip,
      cookies,
      payload: new URLSearchParams(fields).toString(),
    });
    return {
      status: response.statusCode,
      body: response.body,
      headers: response.headers,
      cookies: response.cookies,
    };
  };

  /** A distinct network address per call, so one test's budget is never another's. */
  const freshIp = (): string => {
    sequence += 1;
    return `198.51.${String(Math.floor(sequence / 250))}.${String(sequence % 250)}`;
  };

  const eventually = async <T>(read: () => Promise<T | undefined>, ms = 8000): Promise<T> => {
    const until = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value !== undefined) {
        return value;
      }
      if (Date.now() > until) {
        throw new Error('timed out waiting');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  /** What the outbox holds for sign-in emails of a brand, the sealed envelopes opened. */
  const sealed = (brandId: string) =>
    withSystem(runtime.db, brandId, async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(eq(outbox.event, PORTAL_SIGN_IN_EVENT))
        .orderBy(outbox.id);
      return rows.map((row) => ({
        row,
        ...(JSON.parse(decryptSecret((row.payload as { sealed: string }).sealed, keyring)) as {
          to: string;
          url: string;
        }),
      }));
    });

  /** Opens the form and posts an address, then waits for the work after the response. */
  const ask = async (
    host: string,
    email: string,
    options: { ip?: string; prefix?: string; lang?: string } = {},
  ): Promise<Reply> => {
    const ip = options.ip ?? freshIp();
    const prefix = options.prefix ?? '';
    const opened = await get(host, `${prefix}/sign-in?lang=${options.lang ?? 'en'}`, {}, ip);
    return post(
      host,
      '/sign-in',
      { email, csrf: csrfOf(opened), lang: options.lang ?? 'en' },
      jar(opened),
      ip,
      prefix,
    );
  };

  /** The newest link emailed to an address, once at least `count` have been. */
  const linkFor = async (brandId: string, email: string, count = 1): Promise<string> =>
    eventually(async () => {
      const mails = (await sealed(brandId)).filter((mail) => mail.to === email);
      return mails.length >= count ? mails.at(-1)?.url : undefined;
    });

  const press = async (host: string, url: string, ip = freshIp()) => {
    const link = new URL(url);
    const token = link.searchParams.get('token') ?? '';
    const page = await get(host, `${link.pathname}${link.search}`, {}, ip);
    const done = await post(
      host,
      '/sign-in/confirm',
      { token, csrf: csrfOf(page), lang: 'en' },
      jar(page),
      ip,
    );
    return { token, page, done, cookies: jar(done) };
  };

  const rows = <T>(
    brandId: string,
    read: (tx: Parameters<Parameters<typeof withSystem>[2]>[0]) => Promise<T>,
  ) => withSystem(runtime.db, brandId, read);

  const sessionsOf = (brandId: string) =>
    rows(brandId, (tx) =>
      tx.select().from(customerSessions).where(eq(customerSessions.brandId, brandId)),
    );
  const tokensOf = (brandId: string) =>
    rows(brandId, (tx) =>
      tx.select().from(customerSignInTokens).where(eq(customerSignInTokens.brandId, brandId)),
    );

  const addContact = async (
    brandId: string,
    email: string,
    values: Partial<typeof contacts.$inferInsert> = {},
    verified = false,
  ) => {
    const id = uuidv7();
    const identityId = uuidv7();
    await withSystem(runtime.db, brandId, async (tx) => {
      await tx
        .insert(contacts)
        .values({ id, brandId, name: email.split('@')[0] ?? email, ...values });
      await tx.insert(contactIdentities).values({
        id: identityId,
        brandId,
        contactId: id,
        kind: 'email',
        value: email,
        verified,
        source: 'test',
      });
    });
    return { id, identityId };
  };

  const signedIn = async (email: string, brandId = brandA(), host = HOST_A) => {
    const before = (await sealed(brandId)).filter((mail) => mail.to === email).length;
    await ask(host, email);
    const result = await press(host, await linkFor(brandId, email, before + 1));
    expect(result.done.status, result.done.body).toBe(303);
    return result.cookies;
  };

  let mona: { id: string; identityId: string };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      max: 2,
    });
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      }),
    });
    app = await createApiApp({ runtime, objectStorage: new FakeStorage('/tmp/helpdock-portal') });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    brandB = uuidv7();
    await owner.db.insert(brands).values({ id: brandB, name: 'Globex', prefix: 'GLBX' });
    await owner.db.insert(brandDomains).values([
      {
        brandId: seeded.brandId,
        domain: HOST_A,
        kind: 'helpcenter',
        verifiedAt: new Date(),
        isPrimary: true,
        txtToken: 'helpdock-verify=a',
      },
      {
        brandId: brandB,
        domain: HOST_B,
        kind: 'helpcenter',
        verifiedAt: new Date(),
        isPrimary: true,
        txtToken: 'helpdock-verify=b',
      },
    ]);
    await setPortal(seeded.brandId, { enabled: true });
    await setPortal(brandB, { enabled: true });

    accountId = uuidv7();
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(accounts).values({ id: accountId, brandId: seeded.brandId, name: 'Acme Trading' }),
    );
    mona = await addContact(seeded.brandId, MONA, { accountId });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('the whole flow', () => {
    it('sends a working link, spends it only by POST, verifies the identity and starts a session', async () => {
      const asked = await ask(HOST_A, MONA);
      expect(asked.status).toBe(200);
      expect(asked.body).toContain('Check your email');

      await linkFor(brandA(), MONA);
      const mails = (await sealed(brandA())).filter((mail) => mail.to === MONA);
      expect(mails).toHaveLength(1);
      const link = new URL(mails[0]?.url ?? '');
      const token = link.searchParams.get('token') ?? '';
      expect(`${link.origin}${link.pathname}`).toBe(`https://${HOST_A}/sign-in/confirm`);

      // The outbox row and the table hold neither the address nor the token.
      const payload = JSON.stringify(mails[0]?.row.payload);
      expect(payload).not.toContain(MONA);
      expect(payload).not.toContain(token);
      const stored = (await tokensOf(brandA())).find((row) => row.tokenHash === sha256(token));
      expect(stored).toMatchObject({ email: MONA, contactId: mona.id, spentAt: null });
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(stored?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000);

      // Opening the link, twice, spends nothing.
      for (let n = 0; n < 2; n += 1) {
        const opened = await get(HOST_A, `${link.pathname}${link.search}`);
        expect(opened.status).toBe(200);
        expect(opened.body).toContain('Continue to your tickets');
        expect(opened.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
      }
      expect((await sessionsOf(brandA())).filter((row) => row.contactId === mona.id)).toHaveLength(
        0,
      );
      expect(
        (await tokensOf(brandA())).find((row) => row.tokenHash === sha256(token))?.spentAt,
      ).toBeNull();

      // Continue spends it, verifies the address and starts the session.
      const before = await rows(brandA(), (tx) =>
        tx.select().from(contactIdentities).where(eq(contactIdentities.id, mona.identityId)),
      );
      expect(before[0]?.verified).toBe(false);
      const page = await get(HOST_A, `${link.pathname}${link.search}`);
      const done = await post(
        HOST_A,
        '/sign-in/confirm',
        { token, csrf: csrfOf(page), lang: 'en' },
        jar(page),
      );
      expect(done.status).toBe(303);
      expect(done.headers.location).toBe('/tickets?lang=en');
      const cookie = done.cookies.find((candidate) => candidate.name === '__Host-hd_cs');
      expect(cookie).toMatchObject({ path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
      expect(cookie).not.toHaveProperty('domain');
      expect(cookie?.maxAge).toBe(SESSION_TTL_MS / 1000);

      const after = await rows(brandA(), (tx) =>
        tx.select().from(contactIdentities).where(eq(contactIdentities.id, mona.identityId)),
      );
      expect(after[0]).toMatchObject({ verified: true });
      expect(after[0]?.verifiedAt).toBeInstanceOf(Date);
      const sessions = (await sessionsOf(brandA())).filter((row) => row.contactId === mona.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ host: HOST_A, contactIdentityId: mona.identityId });
      expect(sessions[0]?.tokenHash).toBe(sha256(cookie?.value ?? ''));
      expect(
        (await tokensOf(brandA())).find((row) => row.tokenHash === sha256(token))?.spentAt,
      ).not.toBeNull();

      // A second press is "used" and starts nothing.
      const again = await post(
        HOST_A,
        '/sign-in/confirm',
        { token, csrf: csrfOf(page), lang: 'en' },
        jar(page),
      );
      expect(again.status).toBe(410);
      expect(again.body).toContain('This link was already used');
      expect((await sessionsOf(brandA())).filter((row) => row.contactId === mona.id)).toHaveLength(
        1,
      );

      // The session opens the signed-in page, with the address and company in the menu.
      const landing = await get(HOST_A, '/tickets', jar(done));
      expect(landing.status).toBe(200);
      expect(landing.body).toContain('My tickets');
      expect(landing.body).toContain(MONA);
      expect(landing.body).toContain('Acme Trading');
    });

    it('answers two presses of one link with one session', async () => {
      const email = 'race@acme.example';
      const raced = await addContact(brandA(), email);
      await ask(HOST_A, email);
      const link = new URL(await linkFor(brandA(), email));
      const token = link.searchParams.get('token') ?? '';
      const ip = freshIp();
      const page = await get(HOST_A, `${link.pathname}${link.search}`, {}, ip);
      const press = () =>
        post(HOST_A, '/sign-in/confirm', { token, csrf: csrfOf(page), lang: 'en' }, jar(page), ip);

      const results = await Promise.all([press(), press(), press()]);

      expect(results.filter((reply) => reply.status === 303)).toHaveLength(1);
      expect(results.filter((reply) => reply.status === 410)).toHaveLength(2);
      expect((await sessionsOf(brandA())).filter((row) => row.contactId === raced.id)).toHaveLength(
        1,
      );
    });

    it('works under /hc/<brandId> on the install host, with the brand in the cookie name', async () => {
      const host = 'support.example.com';
      const prefix = `/hc/${brandA()}`;
      const open = await get(host, `${prefix}/sign-in`);
      expect(open.status).toBe(200);
      expect(open.cookies[0]?.name).toBe(`__Host-hd_cn_${brandA()}`);
      expect(open.body).toContain(`action="${prefix}/sign-in"`);
    });
  });

  describe('the sign-in email', () => {
    it('is sent by the job with the link, in the page’s language, and no ticket content', async () => {
      const email = 'mail@acme.example';
      await addContact(brandA(), email);
      await ask(HOST_A, email, { lang: 'ar' });
      await linkFor(brandA(), email);
      const [mail] = (await sealed(brandA())).filter((candidate) => candidate.to === email);
      if (mail === undefined) {
        throw new Error('no sign-in email was queued');
      }
      const sent: { to: string; subject: string; text: string; html: string; locale: string }[] =
        [];
      const handler = createSignInEmailHandler({
        repository: { settings: async () => undefined },
        keyring,
        installSmtp: {
          read: async () => ({
            server: { host: 'smtp.test', port: 25, tls: 'none', user: '', password: '' },
            from: { address: 'support@helpdock.example', name: 'Support' },
          }),
        },
        transports: (_server, from) => ({
          send: async (message) => {
            expect(from.address).toBe('support@helpdock.example');
            sent.push({ ...message, to: message.to.address });
          },
          close: () => undefined,
        }),
      });

      await withSystem(runtime.db, brandA(), (tx) =>
        handler({
          payload: {
            brandId: brandA(),
            sourceOutboxId: mail.row.id,
            locale: 'ar',
            sealed: (mail.row.payload as { sealed: string }).sealed,
          },
          brandId: brandA(),
          tx,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
        } as never),
      );

      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe(email);
      expect(sent[0]?.locale).toBe('ar');
      expect(sent[0]?.html).toContain('dir="rtl"');
      expect(sent[0]?.text).toContain(mail.url);
    });
  });

  describe('who gets a link', () => {
    it('sends nothing for an unknown address, and answers it exactly like a known one', async () => {
      const unknown = 'nobody@elsewhere.example';
      const known = await ask(HOST_A, MONA);
      const stranger = await ask(HOST_A, unknown);

      expect(stranger.status).toBe(known.status);
      expect(stranger.body.replace(unknown, MONA).replace(/nonce="[^"]+"/g, '')).toBe(
        known.body.replace(/nonce="[^"]+"/g, '').replace(/value="[^"]+"/g, ''),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await sealed(brandA())).filter((mail) => mail.to === unknown)).toHaveLength(0);
      expect((await tokensOf(brandA())).filter((row) => row.email === unknown)).toHaveLength(0);
    });

    it('sends to a stranger only when the brand lets new customers in, and creates the contact at the first Continue', async () => {
      const stranger = 'new.person@elsewhere.example';
      await setPortal(brandA(), { enabled: true, newCustomers: true });
      try {
        await ask(HOST_A, stranger);
        const url = await linkFor(brandA(), stranger);
        const token = (await tokensOf(brandA())).find((row) => row.email === stranger);
        expect(token?.contactId).toBeNull();
        expect(
          await rows(brandA(), (tx) =>
            tx.select().from(contactIdentities).where(eq(contactIdentities.value, stranger)),
          ),
        ).toHaveLength(0);

        const result = await press(HOST_A, url);
        expect(result.done.status).toBe(303);
        const [identity] = await rows(brandA(), (tx) =>
          tx.select().from(contactIdentities).where(eq(contactIdentities.value, stranger)),
        );
        expect(identity).toMatchObject({ verified: true, source: 'portal.sign_in', kind: 'email' });
      } finally {
        await setPortal(brandA(), { enabled: true, newCustomers: false });
      }
    });

    it('signs in as the contact an inbound mail created for the address between the request and Continue', async () => {
      const stranger = 'raced@elsewhere.example';
      await setPortal(brandA(), { enabled: true, newCustomers: true });
      try {
        await ask(HOST_A, stranger);
        const url = await linkFor(brandA(), stranger);
        const inbound = await addContact(brandA(), stranger, {}, true);

        const result = await press(HOST_A, url);

        expect(result.done.status).toBe(303);
        const holders = await rows(brandA(), (tx) =>
          tx.select().from(contactIdentities).where(eq(contactIdentities.value, stranger)),
        );
        expect(holders).toHaveLength(1);
        expect(holders[0]).toMatchObject({ contactId: inbound.id, verified: true });
        const made = await rows(brandA(), (tx) =>
          tx.select().from(contacts).where(eq(contacts.name, 'raced')),
        );
        expect(made.map((contact) => contact.id)).toEqual([inbound.id]);
        const sessions = (await sessionsOf(brandA())).filter((row) => row.contactId === inbound.id);
        expect(sessions).toHaveLength(1);
        const token = (await tokensOf(brandA())).find((row) => row.email === stranger);
        expect(token?.spentAt).not.toBeNull();
      } finally {
        await setPortal(brandA(), { enabled: true, newCustomers: false });
      }
    });

    it('verifies an address a contact only typed, on that contact, without making a second one', async () => {
      const email = 'typed@acme.example';
      const typed = await addContact(brandA(), email, {}, false);
      await ask(HOST_A, email);
      await press(HOST_A, await linkFor(brandA(), email));

      const [identity] = await rows(brandA(), (tx) =>
        tx.select().from(contactIdentities).where(eq(contactIdentities.value, email)),
      );
      expect(identity).toMatchObject({ contactId: typed.id, verified: true });
    });

    it('leaves the link unspent and makes no contact when nobody may be signed in at Continue', async () => {
      const stranger = 'late.switch@elsewhere.example';
      await setPortal(brandA(), { enabled: true, newCustomers: true });
      await ask(HOST_A, stranger);
      const url = await linkFor(brandA(), stranger);
      await setPortal(brandA(), { enabled: true, newCustomers: false });

      const result = await press(HOST_A, url);

      expect(result.done.status).toBe(410);
      expect(result.done.body).toContain('This link has expired');
      expect((await tokensOf(brandA())).find((row) => row.email === stranger)?.spentAt).toBeNull();
      expect(
        await rows(brandA(), (tx) =>
          tx.select().from(contactIdentities).where(eq(contactIdentities.value, stranger)),
        ),
      ).toHaveLength(0);
      expect(
        await rows(brandA(), (tx) =>
          tx.select().from(contacts).where(eq(contacts.name, 'late.switch')),
        ),
      ).toHaveLength(0);
    });

    it('never sends to a contact that was merged away or anonymised, even for new customers', async () => {
      const merged = 'merged@acme.example';
      const erased = 'erased@acme.example';
      await addContact(brandA(), merged, { mergedIntoId: mona.id });
      await addContact(brandA(), erased, { anonymisedAt: new Date() });
      await setPortal(brandA(), { enabled: true, newCustomers: true });
      try {
        await ask(HOST_A, merged);
        await ask(HOST_A, erased);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const mails = (await sealed(brandA())).map((mail) => mail.to);
        expect(mails).not.toContain(merged);
        expect(mails).not.toContain(erased);
        expect((await tokensOf(brandA())).map((row) => row.email)).not.toEqual(
          expect.arrayContaining([merged]),
        );
      } finally {
        await setPortal(brandA(), { enabled: true, newCustomers: false });
      }
    });

    it('sends to an address whose identity is not verified yet', async () => {
      const email = 'unverified@acme.example';
      await addContact(brandA(), email, {}, false);
      await ask(HOST_A, email);

      expect(await linkFor(brandA(), email)).toContain('/sign-in/confirm?token=');
    });
  });

  describe('links that must not work', () => {
    it('shows the expired page for a link past its fifteen minutes, on the page and on the press', async () => {
      const email = 'late@acme.example';
      await addContact(brandA(), email);
      await ask(HOST_A, email);
      const url = await linkFor(brandA(), email);
      const link = new URL(url);
      const token = link.searchParams.get('token') ?? '';
      const page = await get(HOST_A, `${link.pathname}${link.search}`);
      await rows(brandA(), (tx) =>
        tx
          .update(customerSignInTokens)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(customerSignInTokens.tokenHash, sha256(token))),
      );

      const opened = await get(HOST_A, `${link.pathname}${link.search}`);
      expect(opened.status).toBe(410);
      expect(opened.body).toContain('This link has expired');
      const pressed = await post(
        HOST_A,
        '/sign-in/confirm',
        { token, csrf: csrfOf(page) },
        jar(page),
      );
      expect(pressed.status).toBe(410);
      expect(pressed.cookies.filter((cookie) => cookie.name.includes('hd_cs'))).toHaveLength(0);
    });

    it('treats a brand A link on brand B’s host as expired, and spends nothing', async () => {
      const url = await linkFor(brandA(), MONA);
      const link = new URL(url);
      const token = link.searchParams.get('token') ?? '';

      const onB = await get(HOST_B, `${link.pathname}${link.search}`);
      expect(onB.body).toContain('This link has expired');
      const page = await get(HOST_B, '/sign-in');
      const pressed = await post(
        HOST_B,
        '/sign-in/confirm',
        { token, csrf: csrfOf(page) },
        jar(page),
      );
      expect(pressed.body).toContain('This link has expired');
      expect(
        (await tokensOf(brandA())).find((row) => row.tokenHash === sha256(token))?.spentAt ?? null,
      ).toBeNull();
      expect(await sessionsOf(brandB)).toHaveLength(0);
    });

    it('does not spend a link on a press with a bad CSRF token', async () => {
      const email = 'csrf@acme.example';
      await addContact(brandA(), email);
      await ask(HOST_A, email);
      const link = new URL(await linkFor(brandA(), email));
      const token = link.searchParams.get('token') ?? '';
      const page = await get(HOST_A, `${link.pathname}${link.search}`);

      const forged = await post(HOST_A, '/sign-in/confirm', { token, csrf: 'forged' }, jar(page));
      const noCookie = await post(HOST_A, '/sign-in/confirm', { token, csrf: csrfOf(page) });

      expect(forged.status).toBe(403);
      expect(noCookie.status).toBe(403);
      expect(
        (await tokensOf(brandA())).find((row) => row.tokenHash === sha256(token))?.spentAt,
      ).toBeNull();
    });
  });

  describe('limits', () => {
    it('refuses the sixth link request for one address in an hour and sends nothing more', async () => {
      const email = 'limited@acme.example';
      await addContact(brandA(), email);
      const answers: number[] = [];
      for (let n = 0; n < 6; n += 1) {
        answers.push((await ask(HOST_A, email)).status);
      }

      expect(answers).toEqual([200, 200, 200, 200, 200, 429]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await sealed(brandA())).filter((mail) => mail.to === email)).toHaveLength(
        PORTAL_LINK_EMAIL_RULE.limit,
      );
    });

    it('refuses the 21st request from one address of the network in an hour', async () => {
      const ip = '192.0.2.77';
      const answers: number[] = [];
      for (let n = 0; n < 21; n += 1) {
        answers.push((await ask(HOST_A, `spray${String(n)}@elsewhere.example`, { ip })).status);
      }

      expect(answers.slice(0, 20).every((status) => status === 200)).toBe(true);
      expect(answers[20]).toBe(429);
    });
  });

  describe('the session', () => {
    it('slides: a request after the touch interval pushes the expiry to thirty days, one inside it writes nothing', async () => {
      const email = 'slide@acme.example';
      await addContact(brandA(), email);
      const cookies = await signedIn(email);
      const hash = sha256(cookies['__Host-hd_cs'] ?? '');
      const read = () =>
        rows(
          brandA(),
          async (tx) =>
            (
              await tx.select().from(customerSessions).where(eq(customerSessions.tokenHash, hash))
            )[0],
        );

      const first = await read();
      expect((await get(HOST_A, '/tickets', cookies)).status).toBe(200);
      expect((await read())?.lastSeenAt).toEqual(first?.lastSeenAt);

      const old = new Date(Date.now() - 60 * 60_000);
      await rows(brandA(), (tx) =>
        tx
          .update(customerSessions)
          .set({ lastSeenAt: old, expiresAt: new Date(Date.now() + 5 * 86_400_000) })
          .where(eq(customerSessions.tokenHash, hash)),
      );
      expect((await get(HOST_A, '/tickets', cookies)).status).toBe(200);
      const touched = await read();
      expect(touched?.lastSeenAt.getTime()).toBeGreaterThan(old.getTime() + 59 * 60_000);
      expect(touched?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    });

    it('refuses an expired session and removes it', async () => {
      const email = 'expired@acme.example';
      await addContact(brandA(), email);
      const cookies = await signedIn(email);
      const hash = sha256(cookies['__Host-hd_cs'] ?? '');
      await rows(brandA(), (tx) =>
        tx
          .update(customerSessions)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(customerSessions.tokenHash, hash)),
      );

      expect((await get(HOST_A, '/tickets', cookies)).status).toBe(303);
      expect(
        await rows(brandA(), (tx) =>
          tx.select().from(customerSessions).where(eq(customerSessions.tokenHash, hash)),
        ),
      ).toHaveLength(0);
    });

    it('refuses a session on another brand’s host, and a cookie it does not know', async () => {
      const email = 'hostbound@acme.example';
      await addContact(brandA(), email);
      const cookies = await signedIn(email);

      expect((await get(HOST_A, '/tickets', cookies)).status).toBe(200);
      expect((await get(HOST_B, '/tickets', cookies)).status).toBe(303);
      expect((await get(HOST_A, '/tickets', { '__Host-hd_cs': 'A'.repeat(43) })).status).toBe(303);
    });

    const refusedAfter = async (
      name: string,
      change: (ids: { contactId: string; identityId: string }) => Promise<void>,
      restore: (ids: { contactId: string; identityId: string }) => Promise<void> = async () =>
        undefined,
    ) => {
      const email = `${name}@acme.example`;
      const ids = { ...(await addContact(brandA(), email)) };
      const contactId = ids.id;
      const cookies = await signedIn(email);
      expect((await get(HOST_A, '/tickets', cookies)).status).toBe(200);
      await change({ contactId, identityId: ids.identityId });
      try {
        const after = await get(HOST_A, '/tickets', cookies);
        expect(after.status, name).toBe(303);
        expect(after.headers.location).toContain('/sign-in');
      } finally {
        await restore({ contactId, identityId: ids.identityId });
      }
    };

    it('refuses it once the email identity is removed', () =>
      refusedAfter('removed', ({ identityId }) =>
        rows(brandA(), async (tx) => {
          await tx.delete(contactIdentities).where(eq(contactIdentities.id, identityId));
        }),
      ));

    it('refuses it once the email identity is unverified', () =>
      refusedAfter('unverified-later', ({ identityId }) =>
        rows(brandA(), async (tx) => {
          await tx
            .update(contactIdentities)
            .set({ verified: false })
            .where(eq(contactIdentities.id, identityId));
        }),
      ));

    it('refuses the merged-away contact’s session', () =>
      refusedAfter('merged-later', ({ contactId }) =>
        rows(brandA(), async (tx) => {
          await tx
            .update(contacts)
            .set({ mergedIntoId: mona.id })
            .where(eq(contacts.id, contactId));
        }),
      ));

    it('refuses it after erasure', () =>
      refusedAfter('erased-later', ({ contactId }) =>
        rows(brandA(), async (tx) => {
          await tx
            .update(contacts)
            .set({ anonymisedAt: new Date() })
            .where(eq(contacts.id, contactId));
        }),
      ));

    it('refuses every session of a brand that turns the portal off, and every portal address answers 404', async () => {
      const email = 'portaloff@acme.example';
      await addContact(brandA(), email);
      const cookies = await signedIn(email);
      await setPortal(brandA(), { enabled: false });
      try {
        for (const path of ['/tickets', '/sign-in', '/sign-in/confirm?token=x']) {
          expect((await get(HOST_A, path, cookies)).status, path).toBe(404);
        }
        expect((await post(HOST_A, '/sign-in', { email })).status).toBe(404);
        expect((await post(HOST_A, '/sign-out', {}, cookies)).status).toBe(404);
      } finally {
        await setPortal(brandA(), { enabled: true });
      }
      // On again, the session is still there: only the pages were gone.
      expect((await get(HOST_A, '/tickets', cookies)).status).toBe(200);
    });
  });

  describe('signing out', () => {
    it('ends this session on Sign out, and every session of the contact on Sign out everywhere', async () => {
      const email = 'out@acme.example';
      const { id } = await addContact(brandA(), email);
      const one = await signedIn(email);
      const two = await signedIn(email);
      const count = async () =>
        (await sessionsOf(brandA())).filter((row) => row.contactId === id).length;
      expect(await count()).toBe(2);

      const landing = await get(HOST_A, '/tickets', one);
      const out = await post(HOST_A, '/sign-out', { csrf: csrfOf(landing) }, one);
      expect(out.status).toBe(303);
      expect(out.headers.location).toBe('/en');
      expect(out.cookies.find((cookie) => cookie.name === '__Host-hd_cs')).toMatchObject({
        value: '',
        maxAge: 0,
      });
      expect(await count()).toBe(1);
      expect((await get(HOST_A, '/tickets', one)).status).toBe(303);
      expect((await get(HOST_A, '/tickets', two)).status).toBe(200);

      const second = await get(HOST_A, '/tickets', two);
      const everywhere = await post(HOST_A, '/sign-out-everywhere', { csrf: csrfOf(second) }, two);
      expect(everywhere.status).toBe(303);
      expect(await count()).toBe(0);
    });

    it('refuses to sign out without the session’s CSRF token', async () => {
      const email = 'csrfout@acme.example';
      await addContact(brandA(), email);
      const cookies = await signedIn(email);
      const forged = await post(HOST_A, '/sign-out', { csrf: 'forged' }, cookies);

      expect(forged.status).toBe(403);
      expect((await get(HOST_A, '/tickets', cookies)).status).toBe(200);
    });
  });

  describe('credentials of the other kinds', () => {
    it('refuses the customer cookie on a staff route, and a staff session on a portal route', async () => {
      await addContact(brandA(), 'cross@acme.example');
      const cookies = await signedIn('cross@acme.example');
      const staffRoute = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { host: HOST_A },
        cookies,
      });
      expect(staffRoute.statusCode).toBe(401);

      const staffToken = await signInForTest(app, {
        email: seeded.email,
        password: seeded.password,
      });
      const portalRoute = await app.inject({
        method: 'GET',
        url: '/tickets',
        headers: { host: HOST_A, authorization: `Bearer ${staffToken}` },
      });
      expect(portalRoute.statusCode).toBe(303);
      expect(String(portalRoute.headers.location)).toContain('/sign-in');
    });

    it('refuses a widget visitor header and an API key on a portal route alike', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tickets',
        headers: { host: HOST_A, 'x-api-key': 'hd_live_nope', 'x-helpdock-visitor': 'abc' },
      });
      expect(response.statusCode).toBe(303);
    });
  });

  describe('caching', () => {
    it('keeps public pages cacheable with the portal on, and never stores a portal page', async () => {
      await setPortal(brandA(), { enabled: true });
      const publicPage = await get(HOST_A, '/en');
      expect(publicPage.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
      expect(publicPage.body).toContain('href="/tickets?lang=en"');
      const keys = async () => (await runtime.redis.keys(`hc:page:${brandA()}:*`)).length;
      const stored = await keys();
      expect(stored).toBeGreaterThan(0);

      await addContact(brandA(), 'cachey@acme.example');
      const cookies = await signedIn('cachey@acme.example');
      const pages = await Promise.all([
        get(HOST_A, '/sign-in'),
        get(HOST_A, '/sign-in/confirm?token=nothing'),
        get(HOST_A, '/tickets', cookies),
        get(HOST_A, '/tickets'),
      ]);
      for (const page of pages) {
        expect(page.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
        expect(page.headers['x-robots-tag'] ?? page.headers.location).toBeDefined();
      }
      expect(await keys()).toBe(stored);
      // The public page is byte-for-byte the one a signed-in browser gets.
      const again = await get(HOST_A, '/en', cookies);
      expect(again.body.replace(/nonce="[^"]+"/g, '')).toBe(
        publicPage.body.replace(/nonce="[^"]+"/g, ''),
      );
    });
  });

  describe('the portal with the built-in check on', () => {
    it('asks for the check exactly when the brand’s web form does, and refuses a missing solution', async () => {
      await withSystem(runtime.db, brandA(), (tx) =>
        tx
          .insert(webFormSettings)
          .values({ brandId: brandA(), enabled: true, captchaEnabled: true })
          .onConflictDoNothing(),
      );
      await withSystem(runtime.db, brandA(), (tx) =>
        tx
          .update(webFormSettings)
          .set({ captchaEnabled: true })
          .where(eq(webFormSettings.brandId, brandA())),
      );
      try {
        const opened = await get(HOST_A, '/sign-in');
        expect(opened.body).toContain('id="wf-pow"');
        const missing = await post(
          HOST_A,
          '/sign-in',
          { email: MONA, csrf: csrfOf(opened), lang: 'en' },
          jar(opened),
        );
        expect(missing.status).toBe(422);
        expect(missing.body).toContain('The check did not pass');
        const challenge = await get(HOST_A, '/sign-in/challenge');
        expect(challenge.status).toBe(200);
        expect(JSON.parse(challenge.body)).toMatchObject({ algorithm: 'SHA-256' });
      } finally {
        await withSystem(runtime.db, brandA(), (tx) =>
          tx
            .update(webFormSettings)
            .set({ captchaEnabled: false })
            .where(eq(webFormSettings.brandId, brandA())),
        );
      }
      const off = await get(HOST_A, '/sign-in');
      expect(off.body).not.toContain('id="wf-pow"');
      expect((await get(HOST_A, '/sign-in/challenge')).status).toBe(404);
    });
  });

  it('keeps tokens and sessions of one brand out of another’s view', async () => {
    const mine = await rows(brandA(), (tx) =>
      tx.select({ brandId: customerSessions.brandId }).from(customerSessions),
    );
    expect(mine.every((row) => row.brandId === brandA())).toBe(true);
    const theirs = await rows(brandB, (tx) =>
      tx
        .select({ id: customerSignInTokens.id })
        .from(customerSignInTokens)
        .where(and(eq(customerSignInTokens.brandId, brandA()))),
    );
    expect(theirs).toHaveLength(0);
  });
});

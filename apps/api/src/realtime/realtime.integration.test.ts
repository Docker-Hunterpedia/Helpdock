import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  brandRoom,
  departmentRoom,
  type PresenceStatus,
  REALTIME_EVENTS,
  type RoomAck,
  SOCKET_IO_PATH,
  STAFF_NAMESPACE,
  ticketRoom,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { revokedSessionKey } from '../auth/redis-keys.js';
import { REFRESH_COOKIE } from '../auth/session/cookies.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { PresenceService } from './presence.service.js';
import { presenceSocketKey } from './presence.store.js';

/**
 * M0-13 end to end: two api replicas on two ports over one Redis, real sockets,
 * real sessions. It is the only place the pieces that exist only together are
 * proved — the Redis adapter fanning a room across replicas, the reaper turning
 * an expired liveness key into an event, and the five-second revocation of
 * DOMAIN-RULES §1.4 reaching a socket on the *other* replica.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 13).toString('base64');
const APP_URL = 'https://support.example.com';
const COLLEAGUE_PASSWORD = 'a second staff password';
/** The one department the colleague is in; M1 creates the table, M0 only scopes by id. */
const COLLEAGUE_DEPARTMENT = uuidv7();

/** DOMAIN-RULES §1.4 gives revocation five seconds across every replica. */
const REVOCATION_BUDGET_MS = 5_000;

const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the realtime integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Replica {
  readonly runtime: Runtime;
  readonly app: ApiApp;
  readonly url: string;
}

describe.skipIf(!hasDocker)('the realtime gateway', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let colleagueId: string;
  let colleagueEmail: string;
  /** Two replicas, exactly as Compose runs them (ARCHITECTURE §3). */
  const replicas: Replica[] = [];
  const open: Socket[] = [];

  const envFor = (): Env =>
    ({
      APP_URL,
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
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const startReplica = async (): Promise<Replica> => {
    const runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      }),
    });
    const app = await createApiApp({ runtime });
    await app.listen({ port: 0, host: '127.0.0.1' });

    return { runtime, app, url: await app.getUrl() };
  };

  const replica = (index: number): Replica => {
    const found = replicas[index];
    if (found === undefined) {
      throw new Error(`replica ${index} was not started`);
    }

    return found;
  };

  /** A second account, so "someone arrived" and "someone left" are about someone else. */
  const seedColleague = async (db: Db, brandId: string): Promise<string> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }

    const id = uuidv7();
    colleagueEmail = `colleague-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email: colleagueEmail,
      name: 'Colleague',
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(COLLEAGUE_PASSWORD),
    });
    await withSystem(db, brandId, (tx) =>
      tx.insert(userBrandRoles).values({
        userId: id,
        brandId,
        role: 'agent',
        // A null list means "every department" (DOMAIN-RULES §1.1), which is
        // the opposite of what an Agent with a scope is for.
        departmentIds: [COLLEAGUE_DEPARTMENT],
      }),
    );

    return id;
  };

  /** Password sign-in against one replica; the token is good on either. */
  const signIn = async ({
    at = 0,
    email = seeded.email,
    password = seeded.password,
  } = {}): Promise<{ token: string; refreshCookie: string }> => {
    const response = await replica(at).app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password }),
    });

    const body = response.json() as { kind: string; accessToken?: string };
    if (body.kind !== 'session' || body.accessToken === undefined) {
      throw new Error(`sign-in did not produce a session: ${response.body}`);
    }

    const cookie = response.cookies.find((entry) => entry.name === REFRESH_COOKIE);
    return { token: body.accessToken, refreshCookie: `${REFRESH_COOKIE}=${cookie?.value ?? ''}` };
  };

  const connect = (at: number, token: string): Promise<Socket> => {
    const socket = io(`${replica(at).url}${STAFF_NAMESPACE}`, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    open.push(socket);

    return new Promise<Socket>((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  };

  const join = (socket: Socket, room: string, brandId = seeded.brandId): Promise<RoomAck> =>
    socket.emitWithAck(REALTIME_EVENTS.roomJoin, { brandId, room });

  const presenceOf = async (at: number, brandId: string, token: string) => {
    const response = await replica(at).app.inject({
      method: 'GET',
      url: `/api/brands/${brandId}/presence`,
      headers: { authorization: `Bearer ${token}` },
    });

    return {
      status: response.statusCode,
      body: response.json() as { presence: Record<string, PresenceStatus>; brandId: string },
    };
  };

  const signOut = (at: number, token: string, refreshCookie: string) =>
    replica(at).app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { authorization: `Bearer ${token}`, cookie: refreshCookie },
    });

  const eventually = async (
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = REVOCATION_BUDGET_MS,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  beforeAll(async () => {
    // A generous startup timeout because this is the third pair of containers
    // in a coverage run: the ten-second default is about a quiet machine, and
    // "the ports were not bound yet" is not a failure worth reporting.
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    redis = new Redis(redisContainer.getConnectionUrl());

    replicas.push(await startReplica(), await startReplica());
    seeded = await seedDevInstall({ db: replica(0).runtime.db, env: envFor() });
    colleagueId = await seedColleague(replica(0).runtime.db, seeded.brandId);
  }, 300_000);

  afterEach(async () => {
    for (const socket of open.splice(0)) {
      socket.disconnect();
    }
    // Presence is the one thing that outlives a test, because a disconnect is
    // asynchronous and the next test reads the same brand. A drain that does
    // not happen has to fail here rather than confuse the test after it.
    expect(await eventually(async () => Object.keys(await presenceMap()).length === 0, 5_000)).toBe(
      true,
    );
  });

  afterAll(async () => {
    for (const started of replicas) {
      await started.app.close();
      await started.runtime.close();
    }
    await redis?.quit();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  const presenceMap = async (): Promise<Record<string, PresenceStatus>> =>
    replica(0).app.get(PresenceService).mapOf(seeded.brandId);

  describe('the handshake', () => {
    it('accepts a socket carrying a valid access token', async () => {
      const { token } = await signIn();

      expect((await connect(0, token)).connected).toBe(true);
    });

    it.each([
      ['no token at all', ''],
      ['a token this install did not sign', 'not.a.token'],
    ])('refuses a socket with %s, with a code rather than a hang', async (_name, token) => {
      // Socket.IO carries the middleware error's `data` to `connect_error`, so
      // the client gets a code it can translate.
      await expect(connect(0, token)).rejects.toMatchObject({
        data: { code: 'unauthenticated' },
      });
    });
  });

  describe('rooms', () => {
    it('lets a member into their own brand room', async () => {
      const socket = await connect(0, (await signIn()).token);

      expect(await join(socket, brandRoom(seeded.brandId))).toMatchObject({ ok: true });
    });

    it("refuses another brand's room, by either half of the check", async () => {
      const socket = await connect(0, (await signIn()).token);
      const other = uuidv7();

      // Naming the other brand fails the permission guard; naming their own
      // brand and asking for the other's room fails `authorizeRoom`.
      expect(await join(socket, brandRoom(other), other)).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
      expect(await join(socket, brandRoom(other))).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    });

    it('refuses a ticket room for a ticket that does not exist for this principal', async () => {
      const socket = await connect(0, (await signIn()).token);

      // M1-02 fills this check in against `tickets`, and the policies answer:
      // "no such ticket" and "not in your departments" are one answer, so
      // neither confirms the other. The ticket rooms that *are* joinable are
      // proved in `tickets/tickets.integration.test.ts`, which has tickets.
      expect(await join(socket, ticketRoom(uuidv7()))).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    });

    it('refuses an unrestricted scope a department that is not this brand’s', async () => {
      const socket = await connect(0, (await signIn()).token);

      // The seeded account is an Admin, whose department scope is `all` — and
      // `all` means "every department *of this brand*". M1-02 proves that
      // against the `departments` table; an id no brand owns is refused.
      expect(await join(socket, departmentRoom(uuidv7()))).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    });

    it('lets an agent into their own department and refuses every other', async () => {
      const token = (await signIn({ email: colleagueEmail, password: COLLEAGUE_PASSWORD })).token;
      const socket = await connect(0, token);

      expect(await join(socket, departmentRoom(COLLEAGUE_DEPARTMENT))).toMatchObject({ ok: true });
      expect(await join(socket, departmentRoom(uuidv7()))).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    });

    it('serves no transport but websocket, so no deploy needs sticky sessions', async () => {
      const response = await fetch(`${replica(0).url}${SOCKET_IO_PATH}/?EIO=4&transport=polling`);

      expect(response.status).toBe(400);
    });

    it('refuses a message that names no room', async () => {
      const socket = await connect(0, (await signIn()).token);

      expect(
        await socket.emitWithAck(REALTIME_EVENTS.roomJoin, {
          brandId: seeded.brandId,
          room: 'everything',
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    });
  });

  describe('presence across replicas', () => {
    it('reaches the other replica over REST and over the brand room', async () => {
      const watcher = await connect(1, (await signIn({ at: 1 })).token);
      await join(watcher, brandRoom(seeded.brandId));

      const changes: { data: { userId: string; status: PresenceStatus } }[] = [];
      watcher.on(REALTIME_EVENTS.presenceChanged, (envelope) => changes.push(envelope));

      const colleagueToken = (await signIn({ email: colleagueEmail, password: COLLEAGUE_PASSWORD }))
        .token;
      const arriving = await connect(0, colleagueToken);
      await join(arriving, brandRoom(seeded.brandId));

      expect(
        await eventually(() =>
          changes.some(
            (change) => change.data.userId === colleagueId && change.data.status === 'online',
          ),
        ),
      ).toBe(true);

      // REST is the truth (DOMAIN-RULES §7), and it answers the same on either
      // replica because the state is in Redis rather than in a process.
      const map = await presenceOf(1, seeded.brandId, colleagueToken);
      expect(map.body.presence[colleagueId]).toBe('online');
      expect(map.body.presence[seeded.userId]).toBe('online');

      arriving.disconnect();

      expect(
        await eventually(() =>
          changes.some(
            (change) => change.data.userId === colleagueId && change.data.status === 'offline',
          ),
        ),
      ).toBe(true);
    });

    it('turns an explicit away into an event and into the REST map', async () => {
      const { token } = await signIn();
      const socket = await connect(0, token);
      await join(socket, brandRoom(seeded.brandId));

      expect(
        await socket.emitWithAck(REALTIME_EVENTS.presenceSet, {
          brandId: seeded.brandId,
          status: 'away',
        }),
      ).toEqual({ ok: true, data: { status: 'away' } });

      expect((await presenceOf(1, seeded.brandId, token)).body.presence[seeded.userId]).toBe(
        'away',
      );
    });

    it('takes someone offline once their liveness key has expired', async () => {
      const { token } = await signIn();
      const socket = await connect(0, token);
      await join(socket, brandRoom(seeded.brandId));

      // Rather than waiting out the sixty-second TTL, take the key away: that is
      // exactly the state a killed replica leaves behind.
      expect(await redis.exists(presenceSocketKey(socket.id ?? ''))).toBe(1);
      await redis.del(presenceSocketKey(socket.id ?? ''));

      // The other replica's reaper, which never saw this socket connect.
      await replica(1).app.get(PresenceService).sweep();

      expect(
        (await presenceOf(1, seeded.brandId, token)).body.presence[seeded.userId],
      ).toBeUndefined();
    });

    it('refuses the presence map for a brand the caller holds no role in', async () => {
      const { token } = await signIn();

      expect((await presenceOf(0, uuidv7(), token)).status).toBe(403);
    });
  });

  describe('revocation', () => {
    it('disconnects the principal on every replica within five seconds', async () => {
      const { token, refreshCookie } = await signIn();
      const onA = await connect(0, token);
      const onB = await connect(1, token);
      await join(onA, brandRoom(seeded.brandId));
      await join(onB, brandRoom(seeded.brandId));

      const told: unknown[] = [];
      onB.on('revoked', (payload) => told.push(payload));

      // Replica B has never seen this sign-out; only the Redis message reaches it.
      await signOut(0, token, refreshCookie);

      expect(await eventually(() => !onA.connected && !onB.connected)).toBe(true);
      expect(told).toEqual([{ code: 'session_revoked', message: 'sign-out' }]);
    });

    it('refuses a room join on a session that was revoked, and closes the socket', async () => {
      const { token } = await signIn();
      const socket = await connect(0, token);

      // The marker is written straight to Redis rather than through a sign-out,
      // so nothing is published and the pull check is the only thing that can
      // have refused this join. That is the half a lost message depends on.
      const sessionId = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ).sid as string;
      await redis.set(revokedSessionKey(sessionId), '1', 'EX', 600);

      const ack: RoomAck = await join(socket, brandRoom(seeded.brandId));

      expect(ack).toMatchObject({ ok: false, error: { code: 'session_revoked' } });
      expect(await eventually(() => !socket.connected)).toBe(true);
    });
  });
});

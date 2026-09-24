import type { Db } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { startWorker, type WorkerDependencies, type WorkerEnv } from './start-worker.js';

const env: WorkerEnv = {
  REDIS_URL: 'redis://redis:6379',
  DATABASE_URL: 'postgres://helpdock_app:pw@postgres:5432/helpdock',
  S3_ENDPOINT: 'http://minio:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'helpdock',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_FORCE_PATH_STYLE: true,
  FFMPEG_PATH: 'ffmpeg',
  FFPROBE_PATH: 'ffprobe',
  CLAMAV_PORT: 3310,
  APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

const db = {} as Db;

interface Harness {
  readonly deps: WorkerDependencies;
  readonly calls: string[];
  readonly started: {
    redisUrl?: string;
    listenUrl?: string;
    relayRedis?: unknown;
    relayStatus?: unknown;
  };
}

const harness = (): Harness => {
  const calls: string[] = [];
  const started: Harness['started'] = {};
  // Only `quit` is ever called on it, so the double is the smallest thing the
  // BullMQ-shaped signature accepts.
  const connection = { quit: async () => calls.push('connection.quit') } as unknown as Redis;

  return {
    calls,
    started,
    deps: {
      createConnection: (url) => {
        started.redisUrl = url;
        calls.push('connection.create');
        return connection;
      },
      registerHandlers: ({ redis }) => {
        calls.push('handlers.register');
        expect(redis).toBe(connection);
        return { close: async () => void calls.push('producers.close') };
      },
      createEventWorker: ({ redis }) => {
        calls.push('worker.create');
        expect(redis).toBe(connection);
        return { close: async () => void calls.push('worker.close') };
      },
      createMediaWorker: ({ redis }) => {
        calls.push('media.create');
        expect(redis).toBe(connection);
        return { close: async () => void calls.push('media.close') };
      },
      startRelay: ({ redis, listenUrl, status }) => {
        calls.push('relay.start');
        started.listenUrl = listenUrl;
        started.relayRedis = redis;
        started.relayStatus = status;
        return { stop: async () => void calls.push('relay.stop') };
      },
    },
  };
};

describe('startWorker', () => {
  it('registers the handlers and both consumers before the relay that feeds them', () => {
    const { deps, calls } = harness();

    startWorker({ env, db, log: silentLogger, deps });

    // A job that arrives before its consumer exists burns attempts
    // (packages/jobs/README.md).
    expect(calls).toEqual([
      'connection.create',
      'handlers.register',
      'worker.create',
      'media.create',
      'relay.start',
    ]);
  });

  it('gives the relay and the workers one connection, and the relay the LISTEN url', () => {
    const { deps, started } = harness();

    startWorker({ env, db, log: silentLogger, deps });

    expect(started.redisUrl).toBe(env.REDIS_URL);
    // `LISTEN outbox` needs a connection of its own on the runtime role.
    expect(started.listenUrl).toBe(env.DATABASE_URL);
  });

  it('gives the relay somewhere to report its cycles', () => {
    const { deps, started } = harness();

    startWorker({ env, db, log: silentLogger, deps });

    // Without a `status` store the relay never writes `hd:relay:last`, and the
    // System page's Worker card and all three outbox metrics are silently dead
    // (ARCHITECTURE §14). It is the same connection BullMQ uses, because BullMQ
    // owns its client and does not lend it out.
    expect(started.relayStatus).toBe(started.relayRedis);
    expect(started.relayStatus).toBeDefined();
  });

  it('shuts down relay, then workers, then producers, then connection', async () => {
    const { deps, calls } = harness();
    const host = startWorker({ env, db, log: silentLogger, deps });

    calls.length = 0;
    await host.close();

    // The relay stops adding jobs first; the event worker drains before the
    // media worker, because it is what adds media jobs; the connection closes
    // last so an in-flight job still has Redis to report to.
    expect(calls).toEqual([
      'relay.stop',
      'worker.close',
      'media.close',
      'producers.close',
      'connection.quit',
    ]);
  });

  it('shuts down once, however many signals arrive', async () => {
    const { deps, calls } = harness();
    const host = startWorker({ env, db, log: silentLogger, deps });

    calls.length = 0;
    await Promise.all([host.close(), host.close()]);
    await host.close();

    expect(calls).toEqual([
      'relay.stop',
      'worker.close',
      'media.close',
      'producers.close',
      'connection.quit',
    ]);
  });
});

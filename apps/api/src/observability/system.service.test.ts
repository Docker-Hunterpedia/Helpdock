import type { Db, DbTransaction } from '@helpdock/db';
import { RELAY_STATUS_KEY } from '@helpdock/jobs';
import { systemQueuePageSchema, systemStatusSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import type { ReadinessService } from '../runtime/readiness.service.js';
import type { BootFacts } from './boot-facts.js';
import type { QueueRegistry } from './queues.js';
import { SystemService } from './system.service.js';

/**
 * The mapping from readings to the DTO, with every reading faked. What it
 * proves is that the shape the admin parses is the shape the service produces,
 * and that "not configured" and "not reporting" survive as themselves rather
 * than becoming zeroes.
 */

const BOOT_FACTS: BootFacts = {
  runtimeRole: { roleName: 'helpdock_app', superuser: false, bypassRls: false, ownedTables: 0 },
  migrationsApplied: 4,
};

const AUDIT_ROW = {
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
  actorType: 'staff' as const,
  actorId: '0192c3f0-1a2b-7c3d-8e4f-0000000000a2',
  action: 'install.scope.access',
  targetType: 'route',
  targetId: 'GET /api/install/system',
  createdAt: new Date('2026-09-19T09:59:00.000Z'),
};

/** Just enough Drizzle for the one `select … from … orderBy … limit` the service makes. */
const fakeTx = (rows: readonly (typeof AUDIT_ROW)[]): DbTransaction =>
  ({
    select: () => ({
      from: () => ({ orderBy: () => ({ limit: async () => rows }) }),
    }),
  }) as unknown as DbTransaction;

const fakeDb = (rows: Record<string, unknown>[]): Db =>
  ({ execute: async () => rows }) as unknown as Db;

const fakeRedis = (relay: string | null) =>
  ({
    info: async (section: string) =>
      section === 'server' ? 'redis_version:7.4.2\r\n' : 'aof_rewrite_in_progress:0\r\n',
    get: async (key: string) => (key === RELAY_STATUS_KEY ? relay : null),
  }) as never;

const fakeReadiness = (): ReadinessService =>
  ({
    detail: async () => [
      { name: 'database', status: 'up', latencyMs: 3 },
      { name: 'redis', status: 'up', latencyMs: 1 },
      { name: 'settings', status: 'up', latencyMs: 2 },
    ],
  }) as unknown as ReadinessService;

const fakeQueues = (names: readonly string[]): QueueRegistry =>
  ({
    counts: async () =>
      names.map((name, index) => ({
        name,
        waiting: index,
        active: 0,
        failed: index === 1 ? 3 : 0,
        delayed: 0,
        completed: 0,
        oldestWaitingSeconds: index === 0 ? null : 12,
      })),
  }) as unknown as QueueRegistry;

const QUEUE_NAMES = ['inbound', 'outbound', 'sla', 'rules', 'ai', 'knowledge', 'media'];

const serviceWith = ({
  relay = null,
  rows = [{ version: 'PostgreSQL 17.6 (Debian)', state: 'idle', connections: 2 }],
}: {
  relay?: string | null;
  rows?: Record<string, unknown>[];
} = {}) =>
  new SystemService(
    fakeDb(rows),
    fakeRedis(relay),
    fakeReadiness(),
    fakeQueues(QUEUE_NAMES),
    BOOT_FACTS,
  );

const inRequest = <T>(run: () => Promise<T>): Promise<T> => {
  const context = new RequestContext({
    requestId: 'req-1',
    method: 'GET',
    path: '/api/install/system',
  });
  context.tx = fakeTx([AUDIT_ROW]);

  return runInRequestContext(context, run);
};

describe('SystemService.status', () => {
  it('produces exactly what the shared schema describes', async () => {
    const status = await inRequest(() => serviceWith().status());

    expect(systemStatusSchema.safeParse(status).success).toBe(true);
  });

  it('carries the build, the schema and the runtime role the boot check verified', async () => {
    const status = await inRequest(() => serviceWith().status());

    expect(status.build.nodeVersion).toBe(process.version);
    expect(status.database.version).toBe('17.6');
    expect(status.database.migrationsApplied).toBe(4);
    expect(status.database.runtimeRole).toEqual({
      name: 'helpdock_app',
      superuser: false,
      bypassRls: false,
      ownedTables: 0,
    });
  });

  it('summarises the queues to the first five and still counts the dead letters', async () => {
    const status = await inRequest(() => serviceWith().status());

    expect(status.queues.queues).toHaveLength(5);
    expect(status.queues.total).toBe(QUEUE_NAMES.length);
    expect(status.queues.deadLettered).toBe(3);
  });

  it('says the relay is not reporting rather than inventing a backlog of zero', async () => {
    const status = await inRequest(() => serviceWith().status());

    expect(status.relay).toEqual({ reporting: false });
  });

  it('repeats the relay backlog when a relay has reported one', async () => {
    const relay = JSON.stringify({
      at: new Date().toISOString(),
      durationMs: 400,
      pending: 7,
      published: 2,
      brands: 1,
      skipped: 0,
      failed: 0,
    });

    const status = await inRequest(() => serviceWith({ relay }).status());

    expect(status.relay).toMatchObject({ reporting: true, pending: 7, published: 2 });
  });

  it('reports storage and AI spend as not configured, never as zero', async () => {
    const status = await inRequest(() => serviceWith().status());

    expect(status.storage).toEqual({ configured: false });
    expect(status.aiSpend).toEqual({ configured: false });
    expect(status.channels).toEqual([]);
  });

  it('carries the install-scope audit rows as ISO timestamps', async () => {
    const status = await inRequest(() => serviceWith().status());

    expect(status.audit).toEqual([{ ...AUDIT_ROW, createdAt: '2026-09-19T09:59:00.000Z' }]);
  });

  it('still answers when a reading is unavailable, because a gap beats a 500', async () => {
    const service = new SystemService(
      {
        execute: async () => {
          throw new Error('no connection');
        },
      } as unknown as Db,
      fakeRedis(null),
      fakeReadiness(),
      {
        counts: async () => {
          throw new Error('redis went away');
        },
      } as unknown as QueueRegistry,
      BOOT_FACTS,
    );

    const status = await inRequest(() => service.status());

    expect(systemStatusSchema.safeParse(status).success).toBe(true);
    expect(status.database.version).toBeNull();
    expect(status.database.migrationsApplied).toBe(4);
    expect(status.queues).toEqual({ queues: [], total: 0, deadLettered: 0 });
  });
});

describe('SystemService.queuePage', () => {
  it('pages the full list and matches the shared schema', async () => {
    const page = await serviceWith().queuePage({ page: 2, pageSize: 5 });

    expect(systemQueuePageSchema.safeParse(page).success).toBe(true);
    expect(page.queues.map((queue) => queue.name)).toEqual(['knowledge', 'media']);
    expect(page.total).toBe(QUEUE_NAMES.length);
  });
});

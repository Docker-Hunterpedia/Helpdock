import type { SystemQueuePage, SystemStatus } from '@helpdock/schemas';
import type { SystemApi } from './system-api.js';

/**
 * A healthy install, as `GET /api/install/system` describes one. Tests and the
 * Playwright mock both build from it, so a change to the contract breaks both
 * in the same place.
 */
export const healthySystemStatus = (overrides: Partial<SystemStatus> = {}): SystemStatus => ({
  observedAt: new Date().toISOString(),
  build: {
    version: '0.1.0',
    gitSha: 'a2cf2b3',
    nodeVersion: 'v24.18.0',
    uptimeSeconds: 7231,
  },
  api: {
    status: 'ok',
    checks: [
      { name: 'database', status: 'up', latencyMs: 3.2 },
      { name: 'redis', status: 'up', latencyMs: 1.1 },
      { name: 'settings', status: 'up', latencyMs: 2.4 },
    ],
  },
  database: {
    status: 'ok',
    version: '17.6',
    migrationsApplied: 4,
    runtimeRole: {
      name: 'helpdock_app',
      superuser: false,
      bypassRls: false,
      ownedTables: 0,
    },
    latencyMs: 3.2,
  },
  redis: {
    status: 'ok',
    version: '7.4',
    aofRewriteInProgress: false,
    latencyMs: 1.1,
  },
  relay: {
    reporting: true,
    at: new Date().toISOString(),
    durationMs: 400,
    pending: 0,
    published: 0,
    failed: 0,
  },
  queues: {
    queues: [
      queue('inbound'),
      queue('outbound', { waiting: 2, oldestWaitingSeconds: 12 }),
      queue('sla'),
      queue('rules'),
      queue('ai', { failed: 3 }),
    ],
    total: 11,
    deadLettered: 3,
  },
  channels: [],
  storage: { configured: false },
  aiSpend: { configured: false },
  audit: [
    {
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
      actorType: 'staff',
      actorId: '0192c3f0-1a2b-7c3d-8e4f-0000000000a2',
      action: 'install.scope.access',
      targetType: 'route',
      targetId: 'GET /api/install/system',
      createdAt: new Date().toISOString(),
    },
  ],
  ...overrides,
});

/** Every queue ARCHITECTURE §13 declares, in the order the api lists them. */
export const ALL_QUEUE_NAMES = [
  'inbound',
  'outbound',
  'sla',
  'rules',
  'ai',
  'knowledge',
  'media',
  'notify',
  'webhooks',
  'outbox',
  'maintenance',
] as const;

/** What `GET /api/install/system/queues` answers: the whole list, one page. */
export const fullQueuePage = (): SystemQueuePage => ({
  queues: ALL_QUEUE_NAMES.map((name) =>
    queue(name, name === 'outbound' ? { waiting: 2, oldestWaitingSeconds: 12 } : {}),
  ).map((each) => (each.name === 'ai' ? { ...each, failed: 3 } : each)),
  total: ALL_QUEUE_NAMES.length,
  deadLettered: 3,
  page: 1,
  pageSize: 50,
});

/**
 * A `SystemApi` that answers from the fixtures. Both endpoints are stubbed
 * together, because a page that reads one usually reads the other.
 */
export const fakeSystemApi = (overrides: Partial<SystemApi> = {}): SystemApi => ({
  status: async () => healthySystemStatus(),
  queues: async () => fullQueuePage(),
  ...overrides,
});

/** The same install with Redis mid-rewrite: the degraded state the artboard draws. */
export const degradedSystemStatus = (): SystemStatus =>
  healthySystemStatus({
    redis: { status: 'warning', version: '7.4', aofRewriteInProgress: true, latencyMs: 38 },
  });

function queue(
  name: string,
  overrides: Partial<SystemStatus['queues']['queues'][number]> = {},
): SystemStatus['queues']['queues'][number] {
  return {
    name,
    waiting: 0,
    active: 0,
    failed: 0,
    delayed: 0,
    completed: 0,
    oldestWaitingSeconds: null,
    ...overrides,
  };
}

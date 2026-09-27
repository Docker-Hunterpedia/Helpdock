import type { AuditLogPage, AuditRecord, SystemQueuePage, SystemStatus } from '@helpdock/schemas';
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
  auditLog: async () => auditLogPage(),
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

// ---------------------------------------------------------------- M3-08

const HELPDOCK_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const ACME_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b2';

const record = (
  overrides: Partial<AuditRecord> & Pick<AuditRecord, 'id' | 'action'>,
): AuditRecord => ({
  brandId: HELPDOCK_BRAND,
  brandName: 'Helpdock',
  actorType: 'staff',
  actorId: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
  actorName: 'Lina Haddad',
  targetType: 'settings',
  targetId: null,
  ip: '10.0.4.17',
  requestId: '0192a4c1-7f3e-7b21-9c1d-2f0e5a6b7c8d',
  userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  createdAt: '2026-09-27T11:22:08.000Z',
  changes: [],
  details: [],
  ...overrides,
});

/**
 * The rows of the artboard `AdminAuditLog`, as `GET /api/install/audit-log`
 * answers them: already redacted, which is the api's job, so the page only
 * ever draws a `[redacted]` it was handed.
 */
export const auditLogPage = (overrides: Partial<AuditLogPage> = {}): AuditLogPage => ({
  entries: [
    record({
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0001',
      brandId: null,
      brandName: null,
      action: 'settings.updated',
      targetId: 'smtp',
      changes: [
        {
          field: 'smtp.host',
          before: 'mail.old-host.net',
          after: 'smtp.helpdock.com',
          secret: false,
        },
        { field: 'smtp.port', before: '587', after: '465', secret: false },
        { field: 'smtp.secure', before: 'false', after: 'true', secret: false },
        { field: 'smtp.password', before: '[redacted]', after: '[redacted]', secret: true },
      ],
    }),
    record({
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0002',
      brandId: null,
      brandName: null,
      action: 'install.scope.access',
      targetType: 'route',
      targetId: 'GET /api/brands',
      createdAt: '2026-09-27T11:20:51.000Z',
    }),
    record({
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0003',
      actorType: 'system',
      actorId: 'rule:refund-7-days',
      actorName: null,
      action: 'ticket.updated',
      targetType: 'ticket',
      targetId: 'HD-1042',
      ip: null,
      requestId: null,
      userAgent: null,
      createdAt: '2026-09-27T11:02:13.000Z',
    }),
    record({
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0004',
      actorId: '0192c3f0-1a2b-7c3d-8e4f-00000000000b',
      actorName: 'Omar Nasser',
      action: 'macro.updated',
      targetType: 'macro',
      targetId: '0192c3f0-1a2b-7c3d-8e4f-000000000701',
      ip: '10.0.4.22',
      createdAt: '2026-09-27T10:41:09.000Z',
      changes: [{ field: 'name', before: 'Refund sent', after: 'Refund issued', secret: false }],
      details: [{ field: 'kind', value: 'macro', secret: false }],
    }),
    record({
      id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0005',
      brandId: ACME_BRAND,
      brandName: 'Acme Store',
      actorType: 'apikey',
      actorId: 'zapier-sync',
      actorName: null,
      action: 'ticket.created',
      targetType: 'ticket',
      targetId: 'HD-1047',
      ip: '34.201.18.7',
      userAgent: null,
      createdAt: '2026-09-27T09:15:02.000Z',
    }),
  ],
  nextCursor: 'older-page',
  brands: [
    { id: ACME_BRAND, name: 'Acme Store' },
    { id: HELPDOCK_BRAND, name: 'Helpdock' },
  ],
  ...overrides,
});

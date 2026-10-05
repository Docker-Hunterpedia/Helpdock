import {
  type AuditLogPage,
  type AuditRecord,
  type Brand,
  type BrandDeletion,
  defaultBrandSettings,
  type ProductMetrics,
  type SystemQueuePage,
  type SystemStatus,
} from '@helpdock/schemas';
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
  productMetrics: async () => productMetrics(),
  queueBoardPass: async () => QUEUE_BOARD_PASS,
  brands: async () => installBrands(),
  brandDeletion: async (brandId) => brandDeletionOf(brandId),
  deleteBrand: async (brandId) => pendingDeletion(brandId, Date.now()),
  restoreBrand: async (brandId) => activeDeletion(brandId),
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

// ---------------------------------------------------------------- M8-05, M8-07

/** The mock session's first brand (`auth/mock-api.ts`), so Brand › Danger zone finds itself. */
export const SESSION_BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
export const OLD_STORE_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b3';
export const PILOT_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b4';

const DAY_MS = 86_400_000;
const GRACE_MS = 30 * DAY_MS;
const GIB = 1024 ** 3;

export const QUEUE_BOARD_PASS = '/api/install/system/queue-board/pass-0123456789abcdef';

type BrandStorage = NonNullable<
  Extract<SystemStatus['storage'], { configured: true }>['brands']
>[number];

const brandStorage = (brandId: string, name: string, gibibytes: number): BrandStorage => ({
  brandId,
  name,
  usedBytes: gibibytes * GIB,
  objects: Math.round(gibibytes * 1000),
  measuredAt: '2026-10-05T04:00:00.000Z',
});

/** A System status with storage measured per brand and two channels, one failing. */
export const measuredSystemStatus = (): SystemStatus =>
  healthySystemStatus({
    channels: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c1',
        name: 'support@helpdock.io',
        kind: 'email',
        status: 'ok',
        detail: 'polled 12 s ago',
        checkedAt: new Date().toISOString(),
      },
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c2',
        name: '@acmeshop_help_bot',
        kind: 'telegram',
        status: 'error',
        detail: 'Token rejected',
        checkedAt: new Date().toISOString(),
      },
    ],
    storage: {
      configured: true,
      usedBytes: 18.4 * GIB,
      softLimitBytes: 50 * GIB,
      brands: [
        brandStorage(SESSION_BRAND, 'Helpdock', 11.2),
        brandStorage(ACME_BRAND, 'Acme Store', 6.4),
        brandStorage(OLD_STORE_BRAND, 'Old Store', 0.8),
      ],
    },
  });

/** `GET /api/install/system/metrics`: activated on day 2, AI not recording yet. */
export const productMetrics = (overrides: Partial<ProductMetrics> = {}): ProductMetrics => ({
  observedAt: new Date().toISOString(),
  activation: {
    wizardCompletedAt: '2026-09-01T09:00:00.000Z',
    firstChannelTicketAt: '2026-09-03T11:00:00.000Z',
    activated: true,
  },
  windowDays: 30,
  brands: [
    {
      brandId: SESSION_BRAND,
      name: 'Helpdock',
      selfService: { articleViews: 9412, widgetViews: 2000, followedByTicket: 432, rate: 0.784 },
      aiDeflectionRate: null,
    },
  ],
  ...overrides,
});

const installBrand = (
  id: string,
  name: string,
  prefix: string,
  status: Brand['status'],
): Brand => ({
  id,
  name,
  prefix,
  defaultLocale: 'en',
  timezone: 'Asia/Amman',
  status,
  settings: defaultBrandSettings(),
});

/** `GET /api/install/brands`: two active brands and two in their grace. */
export const installBrands = (): Brand[] => [
  installBrand(SESSION_BRAND, 'Helpdock', 'HD', 'active'),
  installBrand(ACME_BRAND, 'Acme Store', 'ACM', 'active'),
  installBrand(OLD_STORE_BRAND, 'Old Store', 'OST', 'deleting'),
  installBrand(PILOT_BRAND, 'Pilot brand', 'PLT', 'deleting'),
];

export const activeDeletion = (brandId: string): BrandDeletion => ({
  brandId,
  status: 'active',
  requestedAt: null,
  purgeAfter: null,
});

/** A deletion requested at `requestedAt` (epoch ms), with its 30-day grace. */
export const pendingDeletion = (brandId: string, requestedAt: number): BrandDeletion => ({
  brandId,
  status: 'deleting',
  requestedAt: new Date(requestedAt).toISOString(),
  purgeAfter: new Date(requestedAt + GRACE_MS).toISOString(),
});

/** Old Store has 26 days left and Pilot brand 3: the artboard's two rows. */
export const brandDeletionOf = (brandId: string, now = Date.now()): BrandDeletion => {
  if (brandId === OLD_STORE_BRAND) {
    return pendingDeletion(brandId, now - 4 * DAY_MS);
  }
  if (brandId === PILOT_BRAND) {
    return pendingDeletion(brandId, now - 27 * DAY_MS);
  }

  return activeDeletion(brandId);
};

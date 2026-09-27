import type { EmailMessage } from '@helpdock/channels';
import type { Db, DbTransaction } from '@helpdock/db';
import { type JobLogger, notifyEmailJob, notifyPushJob, silentLogger } from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  createEmailHandler,
  createNotifyProcessor,
  createPushHandler,
  type DeliveryWorkerDeps,
  pushPayloadFor,
  testPushPayload,
} from './delivery.js';
import type {
  DeliveryFacts,
  MessageFacts,
  NotificationsRepository,
  SubscriptionRow,
  TicketFacts,
} from './notifications.repository.js';
import type { PushPayload, PushSender, VapidKeys } from './push.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
const NOTIFICATION = '0199f4b2-7777-7000-8000-000000000001';
const SUBSCRIPTION = '0199f4b2-8888-7000-8000-000000000001';
const OMAR = '0199f4b2-1111-7000-8000-000000000002';
const TEST = '0199f4b2-6666-7000-8000-000000000009';

const VAPID: VapidKeys = { publicKey: 'public', privateKey: 'private' };

const ticket: TicketFacts = {
  id: TICKET,
  departmentId: 'd',
  departmentName: 'Billing',
  departmentNameAr: 'الفوترة',
  assigneeId: OMAR,
  teamId: null,
  reference: 'HD-1042',
  subject: 'Refund not received',
  priority: 'high',
  contactName: 'Mona Khalil',
};

const notification = (overrides: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  id: NOTIFICATION,
  kind: 'mentioned',
  userId: OMAR,
  userName: 'Omar Nasser',
  userEmail: 'omar@x.test',
  userLocale: 'en',
  userDeactivated: false,
  ticketId: TICKET,
  messageId: 'message-1',
  actorName: 'Lina Haddad',
  detail: {},
  inApp: true,
  email: true,
  push: true,
  createdAt: new Date(),
  ...overrides,
});

const subscription: SubscriptionRow = {
  id: SUBSCRIPTION,
  userId: OMAR,
  endpoint: 'https://push.example.com/a',
  p256dh: 'k',
  auth: 'a',
  label: '',
  createdAt: new Date(),
};

const message: MessageFacts = {
  id: 'message-1',
  kind: 'note',
  authorType: 'staff',
  authorId: 'lina',
  bodyText: '@Omar please check',
  channel: 'manual',
};

interface Harness {
  readonly deps: DeliveryWorkerDeps;
  readonly sent: EmailMessage[];
  readonly pushed: PushPayload[];
  readonly deleted: string[];
  readonly warnings: string[];
  readonly log: JobLogger;
}

const harness = ({
  delivery = notification(),
  mailer = true,
  vapid = true,
  outcome = 'sent',
  subscriptionRow = subscription,
  ticketRow = ticket,
}: {
  delivery?: DeliveryFacts | null;
  mailer?: boolean;
  vapid?: boolean;
  outcome?: 'sent' | 'gone';
  subscriptionRow?: SubscriptionRow | null;
  ticketRow?: TicketFacts | null;
} = {}): Harness => {
  const sent: EmailMessage[] = [];
  const pushed: PushPayload[] = [];
  const deleted: string[] = [];
  const warnings: string[] = [];
  const repository = {
    delivery: async () => delivery ?? undefined,
    ticket: async () => ticketRow ?? undefined,
    userName: async () => 'Omar Nasser',
    message: async () => message,
    subscription: async () => subscriptionRow ?? undefined,
    deleteSubscription: async (_tx: DbTransaction, id: string) => {
      deleted.push(id);
      return true;
    },
    account: async () => ({ email: 'omar@x.test', locale: 'ar' as const }),
  } as unknown as NotificationsRepository;
  const push: PushSender = {
    send: async (_target, payload) => {
      pushed.push(payload);
      return outcome;
    },
  };
  const record = (_fields: Record<string, unknown>, text: string): void => {
    warnings.push(text);
  };

  return {
    deps: {
      repository,
      push,
      appUrl: 'https://desk.example.com',
      settings: {
        systemSender: async () =>
          mailer ? { send: async (email: EmailMessage) => void sent.push(email) } : null,
        vapidKeys: async () => (vapid ? VAPID : null),
      },
    },
    sent,
    pushed,
    deleted,
    warnings,
    log: { info: record, warn: record, error: record },
  };
};

const context = <T>(payload: T, log: JobLogger = silentLogger) => ({
  payload,
  brandId: BRAND,
  tx: {} as DbTransaction,
  job: {} as Job,
  log,
});

describe('the notify.email handler', () => {
  it('sends the rendered email from the system sender', async () => {
    const h = harness();
    await createEmailHandler(h.deps)(context({ brandId: BRAND, notificationId: NOTIFICATION }));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.subject).toBe('[HD-1042] Lina Haddad mentioned you');
    expect(h.sent[0]?.text).toContain('@Omar please check');
  });

  it('names the department in the recipient language', async () => {
    const h = harness({ delivery: notification({ userLocale: 'ar' }) });
    await createEmailHandler(h.deps)(context({ brandId: BRAND, notificationId: NOTIFICATION }));

    expect(h.sent[0]?.text).toContain('الفوترة');
  });

  it('logs and finishes on an install without SMTP, rather than retrying forever', async () => {
    const h = harness({ mailer: false });
    await createEmailHandler(h.deps)(
      context({ brandId: BRAND, notificationId: NOTIFICATION }, h.log),
    );

    expect(h.sent).toEqual([]);
    expect(h.warnings).toEqual(['Notification email not sent: this install has no SMTP settings.']);
  });

  it.each([
    ['a row that is gone', { delivery: null }],
    ['a row made without email', { delivery: notification({ email: false }) }],
    ['a recipient deactivated since', { delivery: notification({ userDeactivated: true }) }],
    ['a ticket that is gone', { ticketRow: null }],
  ])('sends nothing for %s', async (_name, options) => {
    const h = harness(options);
    await createEmailHandler(h.deps)(context({ brandId: BRAND, notificationId: NOTIFICATION }));

    expect(h.sent).toEqual([]);
  });
});

describe('the notify.push handler', () => {
  const payload = { brandId: BRAND, subscriptionId: SUBSCRIPTION, notificationId: NOTIFICATION };

  it('pushes the heading and the subject, linking to the ticket', async () => {
    const h = harness();
    await createPushHandler(h.deps)(context(payload));

    expect(h.pushed).toEqual([
      {
        title: 'Lina Haddad mentioned you on HD-1042',
        body: 'Refund not received',
        url: `/tickets/${TICKET}`,
        tag: NOTIFICATION,
      },
    ]);
  });

  it('deletes a subscription the push service says is gone (ADR 0002)', async () => {
    const h = harness({ outcome: 'gone' });
    await createPushHandler(h.deps)(context(payload));

    expect(h.deleted).toEqual([SUBSCRIPTION]);
  });

  it('sends a test push in the owner language', async () => {
    const h = harness();
    await createPushHandler(h.deps)(
      context({ brandId: BRAND, subscriptionId: SUBSCRIPTION, testId: TEST }),
    );

    expect(h.pushed).toEqual([testPushPayload('ar', TEST)]);
  });

  it.each([
    ['a browser that is gone', { subscriptionRow: null }],
    ['an install without VAPID keys', { vapid: false }],
    ['a row made without push', { delivery: notification({ push: false }) }],
    ['a browser that changed hands', { delivery: notification({ userId: 'someone-else' }) }],
    ['a ticket that is gone', { ticketRow: null }],
  ])('pushes nothing for %s', async (_name, options) => {
    const h = harness(options);
    await createPushHandler(h.deps)(context(payload));

    expect(h.pushed).toEqual([]);
  });
});

describe('pushPayloadFor', () => {
  it('falls back to generic names when the actor and clock are unknown', () => {
    expect(
      pushPayloadFor(notification({ kind: 'sla_breached', actorName: null }), {
        ...ticket,
        contactName: null,
      }).title,
    ).toBe('HD-1042 missed its SLA target');
  });
});

describe('createNotifyProcessor', () => {
  it('refuses a job name the queue does not carry', async () => {
    const processor = createNotifyProcessor(harness().deps, { db: {} as Db });

    await expect(processor({ name: 'notify.telegram', id: '1', data: {} } as Job)).rejects.toThrow(
      /does not handle notify\.telegram/,
    );
  });

  it('routes each job name to its own consumer', async () => {
    const processor = createNotifyProcessor(harness().deps, { db: {} as Db });

    // Both fail on the payload before touching the database, which is enough to
    // show which definition each name reached.
    await expect(
      processor({ name: notifyEmailJob.name, id: '1', data: {} } as Job),
    ).rejects.toThrow(/notify\.email/);
    await expect(processor({ name: notifyPushJob.name, id: '2', data: {} } as Job)).rejects.toThrow(
      /notify\.push/,
    );
  });
});

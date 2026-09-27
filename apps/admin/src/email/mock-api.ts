import { resources } from '@helpdock/i18n';
import type {
  AutoReplies,
  AutoReplyKind,
  AutoReplyTemplates,
  EmailOutgoingSettings,
  EmailSenders,
  EmailSignature,
  FailedSend,
  FailedSendList,
  MessageDelivery,
  OutgoingSmtpTestResult,
  OutgoingSmtpUpdate,
  TicketEmailContext,
} from '@helpdock/schemas';
import { emailSignatureSchema } from '@helpdock/schemas';
import { AuthError } from '../auth/api.js';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import type { EmailApi } from './api.js';

/**
 * The fixture behind the outbound email screens, drawn from the artboards:
 * `AdminEmailOutgoing` (a Fastmail server, three failed sends), `AdminSignature`
 * and `AdminTicketEmail` (a reply on HD-1042 that was not delivered).
 *
 * "Test SMTP" fails for any host with `fail` in it, which is how the unit and
 * Playwright tests reach the refusal card.
 */

const [SUPPORT, BILLING] = MOCK_DEPARTMENTS;

/** HD-1042's staff reply in `tickets/mock-api.ts` (`msgId(4)`), the one drawn as not delivered. */
export const MOCK_UNDELIVERED_MESSAGE = '0192c3f0-1a2b-7c3d-8e4f-000000000704';
const MOCK_TICKET_REFUND = '0192c3f0-1a2b-7c3d-8e4f-000000001042';

export const MOCK_FAILED_SEND = '0192c3f0-1a2b-7c3d-8e4f-000000000f01';

const catalogTemplates = (kind: AutoReplyKind): AutoReplyTemplates => ({
  en: { ...resources.en.email.autoReply[kind] },
  ar: { ...resources.ar.email.autoReply[kind] },
});

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

export class MockEmailApi implements EmailApi {
  #settings: EmailOutgoingSettings = {
    smtp: {
      host: 'smtp.fastmail.com',
      port: 465,
      tls: 'tls',
      user: 'support@helpdock.io',
      passwordSet: true,
      updatedAt: '2026-09-14T09:00:00.000Z',
      updatedByName: 'Lina Haddad',
    },
    installSmtpConfigured: true,
    senders: {
      defaultFrom: { name: 'Helpdock Support', address: 'support@helpdock.io' },
      departments: [
        {
          departmentId: BILLING?.id ?? '',
          from: { name: 'Helpdock Billing', address: 'billing@helpdock.io' },
          replyTo: 'billing@helpdock.io',
        },
      ],
    },
    autoReplies: {
      acknowledgment: { enabled: true, templates: catalogTemplates('acknowledgment') },
      outOfHours: { enabled: false, templates: catalogTemplates('outOfHours') },
      perSenderHourlyCap: 3,
    },
  };

  #failed: FailedSend[] = [
    {
      id: MOCK_FAILED_SEND,
      recipient: 'mona@example.com',
      ticketId: MOCK_TICKET_REFUND,
      ticketReference: 'HD-1042',
      lastError: '550 5.1.1 <mona@example.com>: Recipient address rejected: mailbox full',
      attempts: 5,
      maxAttempts: 5,
      failedAt: minutesAgo(30),
    },
    {
      id: '0192c3f0-1a2b-7c3d-8e4f-000000000f02',
      recipient: 'k.nasser@acme.de',
      ticketId: '0192c3f0-1a2b-7c3d-8e4f-000000001035',
      ticketReference: 'HD-1035',
      lastError: '550 5.7.1 Message rejected by recipient policy (acme.de)',
      attempts: 5,
      maxAttempts: 5,
      failedAt: minutesAgo(90),
    },
  ];

  #deliveries = new Map<string, MessageDelivery>([
    [
      MOCK_UNDELIVERED_MESSAGE,
      {
        messageId: MOCK_UNDELIVERED_MESSAGE,
        status: 'failed',
        attempts: 5,
        lastError: '550 5.1.1 <mona@example.com>: Recipient address rejected: mailbox full',
      },
    ],
  ]);

  #signature: EmailSignature = {
    en: 'Lina Haddad\nBilling team · Helpdock',
    ar: 'لينا حداد\nفريق الفوترة · Helpdock',
  };

  outgoing(_brandId: string): Promise<EmailOutgoingSettings> {
    return Promise.resolve(structuredClone(this.#settings));
  }

  saveSmtp(_brandId: string, request: OutgoingSmtpUpdate): Promise<EmailOutgoingSettings> {
    const before = this.#settings.smtp;
    this.#settings = {
      ...this.#settings,
      smtp: {
        host: request.host,
        port: request.port,
        tls: request.tls,
        user: request.user,
        passwordSet:
          request.password === undefined ? (before?.passwordSet ?? false) : request.password !== '',
        updatedAt: new Date().toISOString(),
        updatedByName: 'Lina Haddad',
      },
    };
    return this.outgoing(_brandId);
  }

  testSmtp(_brandId: string, request: OutgoingSmtpUpdate): Promise<OutgoingSmtpTestResult> {
    if (request.host.includes('fail')) {
      return Promise.resolve({
        delivered: false,
        recipient: 'lina@helpdock.io',
        durationMs: 640,
        error: 'auth-failed',
        detail: '535 5.7.8 Authentication credentials invalid',
      });
    }

    return Promise.resolve({
      delivered: true,
      recipient: 'lina@helpdock.io',
      durationMs: 800,
      response: '250 2.0.0 Ok: queued as 4Rk9Tz1QmVz3',
    });
  }

  saveSenders(_brandId: string, request: EmailSenders): Promise<EmailOutgoingSettings> {
    this.#settings = { ...this.#settings, senders: structuredClone(request) };
    return this.outgoing(_brandId);
  }

  saveAutoReplies(_brandId: string, request: AutoReplies): Promise<EmailOutgoingSettings> {
    this.#settings = { ...this.#settings, autoReplies: structuredClone(request) };
    return this.outgoing(_brandId);
  }

  failedSends(_brandId: string): Promise<FailedSendList> {
    return Promise.resolve({ items: structuredClone(this.#failed) });
  }

  retryFailedSend(_brandId: string, deliveryId: string): Promise<void> {
    return this.#remove(deliveryId);
  }

  retryAllFailedSends(_brandId: string): Promise<number> {
    const count = this.#failed.length;
    this.#failed = [];
    return Promise.resolve(count);
  }

  discardFailedSend(_brandId: string, deliveryId: string): Promise<void> {
    return this.#remove(deliveryId);
  }

  signature(): Promise<EmailSignature> {
    return Promise.resolve({ ...this.#signature });
  }

  saveSignature(request: EmailSignature): Promise<EmailSignature> {
    const parsed = emailSignatureSchema.safeParse(request);
    if (!parsed.success) {
      return Promise.reject(new AuthError('unavailable'));
    }
    this.#signature = parsed.data;
    return this.signature();
  }

  ticketEmail(_brandId: string, _ticketId: string): Promise<TicketEmailContext> {
    const { senders } = this.#settings;
    const options = [
      ...(senders.defaultFrom === null
        ? []
        : [{ key: 'default' as const, from: senders.defaultFrom }]),
      ...senders.departments.map((row) => ({ key: row.departmentId, from: row.from })),
    ];

    return Promise.resolve({
      senders: options,
      selectedKey: (options.find((option) => option.key !== 'default') ?? options[0])?.key ?? null,
      to: { name: 'Mona Khalil', address: 'mona@example.com' },
      signature: this.#signature.en === '' ? null : this.#signature.en,
      locale: 'en',
      deliveries: [...this.#deliveries.values()],
    });
  }

  retryMessage(_brandId: string, _ticketId: string, messageId: string): Promise<void> {
    const delivery = this.#deliveries.get(messageId);
    if (delivery !== undefined) {
      this.#deliveries.set(messageId, {
        ...delivery,
        status: 'queued',
        attempts: 0,
        lastError: null,
      });
    }
    return Promise.resolve();
  }

  #remove(deliveryId: string): Promise<void> {
    if (!this.#failed.some((row) => row.id === deliveryId)) {
      return Promise.reject(new AuthError('unavailable'));
    }
    this.#failed = this.#failed.filter((row) => row.id !== deliveryId);
    return Promise.resolve();
  }
}

/** The Support department's id, for tests that add a sender row. */
export const MOCK_SUPPORT_DEPARTMENT = SUPPORT?.id ?? '';

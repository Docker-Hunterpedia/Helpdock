import type { EmailMessage } from '@helpdock/channels';
import {
  type DbTransaction,
  type EmailDelivery,
  type EmailOutboundSettings,
  uuidv7,
} from '@helpdock/db';
import type { EmailRepository, ReplyAddressing, SendFacts } from '../email/email.repository.js';
import type { InstallSmtp, SmtpServer, SmtpTransportFactory } from '../email/transport.js';
import { BILLING, deliveryRow, TICKET } from './email-fixtures.js';

/**
 * In-memory stand-ins for the email module's unit tests: a repository that
 * keeps rows in arrays, a transaction that only records outbox inserts, and an
 * SMTP transport that records what it was asked to send.
 */

export interface RecordingTx {
  readonly tx: DbTransaction;
  readonly outbox: { event: string; payload: Record<string, unknown> }[];
  /** `audit_log` rows: every insert that is not an outbox row. */
  readonly audit: Record<string, unknown>[];
}

export const recordingTx = (): RecordingTx => {
  const outbox: RecordingTx['outbox'] = [];
  const audit: RecordingTx['audit'] = [];
  let next = 0;
  const tx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if (typeof values.event === 'string') {
          outbox.push({ event: values.event, payload: values.payload as Record<string, unknown> });
        } else {
          audit.push(values);
        }
        // Awaited as it is for an audit row, or asked for its id as an outbox
        // insert is: a settled promise that also has `returning`.
        return Object.assign(Promise.resolve(), {
          returning: async () => {
            next += 1;
            return [{ id: `outbox-${String(next)}` }];
          },
        });
      },
    }),
  } as unknown as DbTransaction;

  return { tx, outbox, audit };
};

export const addressing = (overrides: Partial<ReplyAddressing> = {}): ReplyAddressing => ({
  ticketId: TICKET,
  departmentId: BILLING,
  contact: { name: 'Mona Khalil', address: 'mona@example.com' },
  locale: 'en',
  cc: ['karim@acme.de'],
  ...overrides,
});

export class FakeEmailRepository {
  settingsRow: EmailOutboundSettings | undefined;
  addressingRow: ReplyAddressing | undefined = addressing();
  deliveries: EmailDelivery[] = [];
  recentAutoReplies = 0;
  facts: SendFacts | undefined;
  saved: Record<string, unknown>[] = [];
  failures: { id: string; attempts: number; error: string; dead: boolean }[] = [];
  signatures = new Map<string, { en: string | null; ar: string | null }>();
  users = new Map<string, { name: string; email: string; locale: 'en' | 'ar' }>();
  departments = new Set<string>([BILLING]);

  settings = async () => this.settingsRow;
  saveSettings = async (_tx: DbTransaction, _brandId: string, patch: Record<string, unknown>) => {
    this.saved.push(patch);
  };
  userName = async (_tx: DbTransaction, id: string) => this.users.get(id)?.name ?? null;
  userAddress = async (_tx: DbTransaction, id: string) => {
    const user = this.users.get(id);
    return user === undefined ? undefined : { email: user.email, locale: user.locale };
  };
  brand = async () => ({ name: 'Helpdock', defaultLocale: 'en' as const });
  departmentIds = async () => this.departments;
  signature = async (_tx: DbTransaction, id: string) => this.signatures.get(id);
  saveSignature = async (
    _tx: DbTransaction,
    id: string,
    value: { en: string | null; ar: string | null },
  ) => {
    this.signatures.set(id, value);
  };
  replyAddressing = async () => this.addressingRow;
  insertDelivery = async (_tx: DbTransaction, values: Partial<EmailDelivery>) => {
    const duplicate = this.deliveries.some(
      (row) =>
        (values.ticketMessageId != null && row.ticketMessageId === values.ticketMessageId) ||
        (values.kind !== 'reply' && row.ticketId === values.ticketId && row.kind === values.kind),
    );
    if (duplicate) {
      return undefined;
    }
    const row = deliveryRow({ ...values, id: uuidv7() });
    this.deliveries.push(row);
    return row;
  };
  delivery = async (_tx: DbTransaction, id: string) => this.deliveries.find((row) => row.id === id);
  deliveryForMessage = async (_tx: DbTransaction, _ticketId: string, messageId: string) =>
    this.deliveries.find((row) => row.ticketMessageId === messageId);
  deliveriesForTicket = async () => this.deliveries;
  markSent = async (_tx: DbTransaction, id: string) => {
    this.#update(id, { status: 'sent' });
  };
  recordFailure = async (
    _tx: DbTransaction,
    id: string,
    failure: { attempts: number; error: string; dead: boolean },
  ) => {
    this.failures.push({ id, ...failure });
  };
  requeue = async (_tx: DbTransaction, ids: readonly string[]) => {
    const rows = this.deliveries.filter(
      (row) => ids.includes(row.id) && (row.status === 'failed' || row.status === 'discarded'),
    );
    for (const row of rows) {
      this.#update(row.id, { status: 'queued', attempts: 0 });
    }
    return rows;
  };
  discard = async (_tx: DbTransaction, id: string) => {
    const row = this.deliveries.find((candidate) => candidate.id === id);
    if (row?.status !== 'failed') {
      return false;
    }
    this.#update(id, { status: 'discarded' });
    return true;
  };
  failedIds = async () =>
    this.deliveries.filter((row) => row.status === 'failed').map((row) => row.id);
  failedSends = async () =>
    this.deliveries
      .filter((row) => row.status === 'failed')
      .map((row) => ({
        id: row.id,
        recipient: row.toAddress,
        ticketId: row.ticketId,
        ticketReference: 'HD-1042',
        lastError: row.lastError,
        attempts: row.attempts,
        failedAt: row.failedAt ?? row.updatedAt,
      }));
  autoRepliesTo = async () => this.recentAutoReplies;
  sendFacts = async () => this.facts;
  threadIds = async () => ({ inReplyTo: undefined, references: [] as string[] });

  #update(id: string, patch: Partial<EmailDelivery>): void {
    this.deliveries = this.deliveries.map((row) => (row.id === id ? { ...row, ...patch } : row));
  }

  get asRepository(): EmailRepository {
    return this as unknown as EmailRepository;
  }
}

export const installSmtp = (
  value: Awaited<ReturnType<InstallSmtp['read']>> = undefined,
): InstallSmtp => ({ read: async () => value });

export interface RecordingTransports {
  readonly factory: SmtpTransportFactory;
  readonly sent: EmailMessage[];
  readonly servers: SmtpServer[];
  closed: number;
  failWith: unknown;
}

export const recordingTransports = (): RecordingTransports => {
  const recording: RecordingTransports = {
    sent: [],
    servers: [],
    closed: 0,
    failWith: undefined,
    factory: (server) => {
      recording.servers.push(server);
      return {
        send: async (message) => {
          if (recording.failWith !== undefined) {
            throw recording.failWith;
          }
          recording.sent.push(message);
        },
        close: () => {
          recording.closed += 1;
        },
      };
    },
  };
  return recording;
};

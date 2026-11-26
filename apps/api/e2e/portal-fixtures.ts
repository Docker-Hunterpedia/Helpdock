import type { MemoryTicket } from '../src/testing/memory-portal.ts';

/**
 * What the portal's Playwright server holds for the ticket pages (M21-03): one
 * company, Acme Trading, set to show every member the company's tickets, with
 * Mona's tickets, her coworker Omar's and a stranger's. The spec reads the same
 * constants, so a subject is typed once.
 */
export const PORTAL_ACME_ACCOUNT = 'account-acme';
/** Known to the memory store, in Acme Trading, under "All members". */
export const PORTAL_MONA = 'mona@acme.example';
/** The same contact under a spelling of its own per language, so no address passes the per-address limit of five. */
export const portalMonaFor = (locale: 'en' | 'ar'): string => `mona-${locale}@acme.example`;
/** Known, in Acme Trading, under "own tickets" only: no switch, no notice. */
export const PORTAL_OWN_ONLY = 'lena-own@acme.example';
export const PORTAL_MANAGER = 'maya-manager@acme.example';

export const TICKET_MINE = {
  reference: 'HD-1042',
  subject: 'Refund not received after 10 days, order 8841',
  file: 'return-label.pdf',
  fileId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
};
export const TICKET_WAITING_US = { reference: 'HD-1038', subject: 'Invoice for order 8790' };
export const TICKET_PRIVATE = { reference: 'HD-1031', subject: 'Change of my delivery address' };
export const TICKET_SOLVED = { reference: 'HD-1000', subject: 'Warranty claim, closed in October' };
export const TICKET_COWORKER = { reference: 'HD-1047', subject: 'Bulk order discount for Q1' };
export const TICKET_COWORKER_PRIVATE = { reference: 'HD-1050', subject: 'Payroll question' };
export const TICKET_STRANGER = { reference: 'HD-2000', subject: 'Not Acme at all' };

const OMAR = { contactId: 'contact-omar', name: 'Omar Saleh' };
const MONA = { contactId: 'contact-mona', name: 'Mona' };
const at = (iso: string): Date => new Date(iso);

const base = {
  channel: 'email' as const,
  accountId: PORTAL_ACME_ACCOUNT,
  private: false,
  messages: [],
  createdAt: at('2026-11-10T11:48:00Z'),
};

export const portalTickets = (now: Date): MemoryTicket[] => [
  {
    ...base,
    reference: TICKET_MINE.reference,
    subject: TICKET_MINE.subject,
    status: 'waiting_you',
    opener: MONA,
    updatedAt: new Date(now.getTime() - 2 * 3_600_000),
    messages: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
        by: { kind: 'contact', ...MONA },
        at: at('2026-11-10T11:48:00Z'),
        text: 'Hello, I returned order 8841 on the 2nd and got the confirmation email, but there is still no refund on my card after 10 days.',
        files: [
          { id: TICKET_MINE.fileId, name: TICKET_MINE.file, mime: 'application/pdf', size: 2048 },
        ],
      },
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000002',
        by: { kind: 'staff', name: 'Lina' },
        at: at('2026-11-10T14:10:00Z'),
        text: 'Hi Mona, the refund was issued on the 4th. Card refunds take 3 to 5 business days. Can you check again and tell us if it has arrived?',
      },
    ],
  },
  {
    ...base,
    reference: TICKET_WAITING_US.reference,
    subject: TICKET_WAITING_US.subject,
    status: 'waiting_us',
    opener: MONA,
    updatedAt: new Date(now.getTime() - 26 * 3_600_000),
  },
  {
    ...base,
    reference: TICKET_PRIVATE.reference,
    subject: TICKET_PRIVATE.subject,
    status: 'open',
    private: true,
    opener: MONA,
    updatedAt: new Date(now.getTime() - 3 * 86_400_000),
  },
  {
    ...base,
    reference: TICKET_SOLVED.reference,
    subject: TICKET_SOLVED.subject,
    status: 'solved',
    opener: MONA,
    updatedAt: new Date(now.getTime() - 10 * 86_400_000),
  },
  {
    ...base,
    reference: TICKET_COWORKER.reference,
    subject: TICKET_COWORKER.subject,
    status: 'waiting_us',
    opener: OMAR,
    createdAt: at('2026-11-22T09:14:00Z'),
    updatedAt: new Date(now.getTime() - 20 * 60_000),
    messages: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000010',
        by: { kind: 'contact', ...OMAR },
        at: at('2026-11-22T09:14:00Z'),
        text: 'We plan to order 400 units a month from January. Is there a volume discount?',
      },
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000011',
        by: { kind: 'staff', name: 'Lina' },
        at: at('2026-11-22T11:02:00Z'),
        text: 'Yes, from 300 units a month. Which delivery terms do you need?',
      },
    ],
  },
  {
    ...base,
    reference: TICKET_COWORKER_PRIVATE.reference,
    subject: TICKET_COWORKER_PRIVATE.subject,
    status: 'open',
    private: true,
    opener: OMAR,
    updatedAt: new Date(now.getTime() - 5 * 86_400_000),
  },
  {
    ...base,
    reference: TICKET_STRANGER.reference,
    subject: TICKET_STRANGER.subject,
    accountId: 'account-other',
    status: 'open',
    opener: { contactId: 'contact-stranger', name: 'Xavier' },
    updatedAt: new Date(now.getTime() - 86_400_000),
  },
];

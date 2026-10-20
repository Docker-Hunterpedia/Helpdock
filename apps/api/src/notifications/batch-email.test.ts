import { describe, expect, it } from 'vitest';
import { type BatchEmailInput, renderBatchEmail } from './batch-email.js';
import { type BatchItem, groupBatch } from './email-batch-content.js';

const SINCE = new Date('2026-10-20T11:52:00.000Z');

let sequence = 0;
const item = (overrides: Partial<BatchItem>): BatchItem => {
  sequence += 1;
  return {
    id: `n-${sequence}`,
    kind: 'replied',
    ticketId: 'ticket-1042',
    reference: 'HD-1042',
    subject: 'Refund not received after 10 days',
    contactName: 'Mona',
    actorName: null,
    detail: {},
    createdAt: SINCE,
    bulkOperationId: null,
    ...overrides,
  };
};

const rows: readonly BatchItem[] = [
  item({
    kind: 'sla_breached',
    ticketId: 'ticket-1038',
    reference: 'HD-1038',
    subject: 'Wrong size delivered',
    contactName: 'Rana S.',
    detail: { clock: 'first_response' },
  }),
  item({ kind: 'mentioned', ticketId: 'ticket-1029', reference: 'HD-1029', actorName: 'Dana' }),
  item({ kind: 'replied' }),
  item({ kind: 'replied' }),
  item({
    kind: 'assigned',
    ticketId: 'ticket-1041',
    reference: 'HD-1041',
    actorName: 'Omar',
    detail: { assignedBy: 'person' },
  }),
];

const input = (overrides: Partial<BatchEmailInput> = {}): BatchEmailInput => {
  const content = groupBatch(
    rows,
    overrides.kind === 'immediate' || !overrides.kind ? 'batch' : 'digest',
  );
  if (content === null) {
    throw new Error('the fixture has rows');
  }

  return {
    kind: 'immediate',
    locale: 'en',
    // 14:52 in Riyadh is 11:52 UTC.
    timeZone: 'Asia/Riyadh',
    to: { address: 'lina@helpdock.test', name: 'Lina Haddad' },
    brandName: 'Acme',
    content,
    appUrl: 'https://desk.example.com',
    now: new Date('2026-10-20T05:00:00.000Z'),
    ...overrides,
  };
};

describe('renderBatchEmail (M14-10, artboard Email/NotificationBatch)', () => {
  it('names the brand and the time in the subject, and counts what happened', () => {
    const email = renderBatchEmail(input());

    expect(email.subject).toBe('[Acme] 5 updates since 14:52');
    expect(email.text).toContain('Acme · since 14:52');
    expect(email.text).toContain('1 assigned, 2 replies, 1 mention, 1 breach');
  });

  it('puts breaches and mentions under Needs you now, and folds the rest per ticket', () => {
    const { text } = renderBatchEmail(input());
    const needs = text.indexOf('Needs you now');
    const tickets = text.indexOf('Tickets');

    expect(needs).toBeGreaterThan(-1);
    expect(tickets).toBeGreaterThan(needs);
    expect(text).toContain(
      'HD-1038 Missed its first response target\nWrong size delivered · Rana S.',
    );
    expect(text).toContain('HD-1029 Dana mentioned you in a note');
    expect(text).toContain('HD-1042 Mona replied 2 times\nRefund not received after 10 days');
    expect(text).toContain('HD-1041 Omar assigned it to you');
    expect(text).toContain('Open your notifications: https://desk.example.com/');
  });

  it('links every ticket line to its ticket and never quotes a message body', () => {
    const { html } = renderBatchEmail(input());

    expect(html).toContain('href="https://desk.example.com/tickets/ticket-1038"');
    expect(html).toContain('lang="en" dir="ltr"');
  });

  it('renders a daily digest for the day in the recipient’s time zone', () => {
    const email = renderBatchEmail(input({ kind: 'daily' }));

    expect(email.subject).toBe('[Acme] Your daily digest for Tue 20 Oct');
    expect(email.text).toContain('Daily digest · Acme');
    expect(email.text).toContain('5 things since Tue 14:52');
    expect(email.text).toContain('2 need you now, 3 are updates. Opened tickets have dropped out.');
  });

  it('renders an hourly digest', () => {
    expect(renderBatchEmail(input({ kind: 'hourly' })).subject).toBe(
      '[Acme] Your hourly digest: 5 updates',
    );
  });

  it('writes Arabic right to left, with Latin digits and isolated references', () => {
    const email = renderBatchEmail(input({ locale: 'ar' }));

    expect(email.locale).toBe('ar');
    expect(email.subject).toBe('[Acme] ‏5 تحديثات منذ 14:52');
    expect(email.html).toContain('lang="ar" dir="rtl"');
    expect(email.text).toContain('تحتاجك الآن');
    expect(email.html).toContain(
      '<bdi style="font-family:\'IBM Plex Mono\', ui-monospace, monospace">HD-1038</bdi>',
    );
  });

  it('escapes what people typed', () => {
    const content = groupBatch(
      [item({ subject: '<img src=x onerror=alert(1)>', contactName: '<b>Mona</b>' })],
      'batch',
    );
    const email = renderBatchEmail({ ...input(), content: content ?? input().content });

    expect(email.html).not.toContain('<img src=x');
    expect(email.html).not.toContain('<b>Mona</b>');
  });

  it.each([
    ['en', 'immediate', 'SLA escalation assigned it to you'],
    ['ar', 'immediate', 'أسنده إليك تصعيد اتفاقية مستوى الخدمة'],
    ['en', 'daily', 'SLA escalation'],
    ['ar', 'daily', 'تصعيد اتفاقية مستوى الخدمة'],
  ] as const)('names SLA assignments in %s %s email', (locale, kind, label) => {
    const content = groupBatch(
      [1, 2].map((number) =>
        item({
          kind: 'assigned',
          ticketId: `sla-${number}`,
          reference: `HD-${number}`,
          detail: { assignedBy: 'sla' },
        }),
      ),
      kind === 'immediate' ? 'batch' : 'digest',
    );
    if (content === null) {
      throw new Error('the fixture has assignments');
    }

    const email = renderBatchEmail(input({ locale, kind, content }));

    expect(email.text).toContain(label);
    expect(email.text).not.toContain('event.assigned.sla');
    expect(email.text).not.toContain('actor.sla');
  });

  it('ends with the footer every notification email shares', () => {
    expect(renderBatchEmail(input()).text).toContain(
      'You get these because of your notification settings. Change them: https://desk.example.com/me/notifications',
    );
  });
});

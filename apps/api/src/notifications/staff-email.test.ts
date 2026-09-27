import { describe, expect, it } from 'vitest';
import { renderStaffNotificationEmail, type StaffEmailInput } from './staff-email.js';

const RECIPIENT = '0199f4b2-1111-7000-8000-000000000002';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';

const input = (overrides: Partial<StaffEmailInput> = {}): StaffEmailInput => ({
  kind: 'sla_breached',
  locale: 'en',
  to: { address: 'lina@helpdock.test', name: 'Lina Haddad' },
  recipientId: RECIPIENT,
  ticket: {
    id: TICKET,
    reference: 'HD-1042',
    subject: 'Refund not received after 10 days',
    departmentName: 'Billing',
    priority: 'urgent',
    contactName: 'Mona Khalil',
    assigneeId: RECIPIENT,
    assigneeName: 'Lina Haddad',
  },
  actorName: null,
  messageText: null,
  detail: { clock: 'first_response' },
  appUrl: 'https://desk.example.com',
  ...overrides,
});

describe('renderStaffNotificationEmail', () => {
  it('renders an SLA breach as the artboard draws it', () => {
    const email = renderStaffNotificationEmail(input());

    expect(email.subject).toBe('[HD-1042] SLA breached: first response');
    expect(email.to).toEqual({ address: 'lina@helpdock.test', name: 'Lina Haddad' });
    expect(email.text).toContain('SLA breach · first response');
    expect(email.text).toContain('HD-1042 missed its first response target');
    expect(email.text).toContain('Assigned to: You');
    expect(email.text).toContain('Priority: Urgent');
    expect(email.text).toContain(`Open HD-1042: https://desk.example.com/tickets/${TICKET}`);
    expect(email.text).toContain('https://desk.example.com/me/notifications');
    expect(email.html).toContain('lang="en" dir="ltr"');
    expect(email.html).toContain('#B3261E');
  });

  it('quotes the note a mention came from and offers to reply', () => {
    const email = renderStaffNotificationEmail(
      input({
        kind: 'mentioned',
        actorName: 'Omar Nasser',
        messageText: 'Checked Stripe. @Lina can you confirm from finance?',
        detail: {},
      }),
    );

    expect(email.subject).toBe('[HD-1042] Omar Nasser mentioned you');
    expect(email.text).toContain('Internal note · Omar Nasser:');
    expect(email.text).toContain('@Lina can you confirm from finance?');
    expect(email.text).toContain('Reply in Helpdock');
    // A mention's summary is the ticket and the department, not the SLA rows.
    expect(email.text).not.toContain('Priority:');
  });

  it('says who made an assignment', () => {
    const byPerson = renderStaffNotificationEmail(
      input({ kind: 'assigned', actorName: 'Omar', detail: { assignedBy: 'person' } }),
    );
    const byRotation = renderStaffNotificationEmail(
      input({ kind: 'assigned', detail: { assignedBy: 'round_robin' } }),
    );

    expect(byPerson.text).toContain('Omar assigned it to you.');
    expect(byRotation.text).toContain('Round-robin assigned it to you.');
  });

  it('writes Arabic right to left, with the reference isolated', () => {
    const email = renderStaffNotificationEmail(input({ locale: 'ar' }));

    expect(email.locale).toBe('ar');
    expect(email.html).toContain('lang="ar" dir="rtl"');
    expect(email.subject).toContain('تجاوز مهلة الرد الأول');
    expect(email.html).toContain(
      '<bdi style="font-family:\'IBM Plex Mono\', ui-monospace, monospace">HD-1042</bdi>',
    );
  });

  it('escapes what people typed', () => {
    const email = renderStaffNotificationEmail(
      input({
        kind: 'replied',
        messageText: '<img src=x onerror=alert(1)>',
        ticket: { ...input().ticket, contactName: '<b>Mona</b>' },
      }),
    );

    expect(email.html).not.toContain('<img src=x');
    expect(email.html).not.toContain('<b>Mona</b>');
    expect(email.html).toContain('&lt;b&gt;Mona&lt;/b&gt;');
  });

  it('names nobody for an unassigned ticket and a colleague by name', () => {
    const unassigned = renderStaffNotificationEmail(
      input({ ticket: { ...input().ticket, assigneeId: null, assigneeName: null } }),
    );
    const colleague = renderStaffNotificationEmail(
      input({ ticket: { ...input().ticket, assigneeId: 'someone-else', assigneeName: 'Sue' } }),
    );

    expect(unassigned.text).toContain('Assigned to: Nobody');
    expect(colleague.text).toContain('Assigned to: Sue');
  });
});

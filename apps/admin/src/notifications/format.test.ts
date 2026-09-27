import { createI18n } from '@helpdock/i18n';
import type { NotificationView } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { useT } from '../app/i18n.js';
import {
  dayGroup,
  groupByDay,
  notificationCaption,
  notificationLine,
  notificationTitle,
  timeAgo,
} from './format.js';

const i18n = createI18n({ lng: 'en' });
const t = i18n.getFixedT('en') as unknown as ReturnType<typeof useT>;
const ar = createI18n({ lng: 'ar' }).getFixedT('ar') as unknown as ReturnType<typeof useT>;

const NOW = new Date('2026-09-27T14:00:00').getTime();

const item = (overrides: Partial<NotificationView> = {}): NotificationView => ({
  id: 'n1',
  kind: 'sla_breached',
  ticketId: 't1',
  ticketReference: 'HD-1042',
  subject: 'Refund not received',
  departmentName: 'Billing',
  departmentNameAr: 'الفوترة',
  actorName: null,
  excerpt: null,
  messageChannel: null,
  detail: { clock: 'first_response' },
  createdAt: new Date(NOW - 2 * 60_000).toISOString(),
  readAt: null,
  ...overrides,
});

describe('timeAgo', () => {
  it.each([
    [10_000, 'just now'],
    [14 * 60_000, '14 min ago'],
    [2 * 3_600_000, '2 h ago'],
    [3 * 86_400_000, '3 days ago'],
  ])('reads %i ms as %s', (elapsed, expected) => {
    expect(timeAgo(t, new Date(NOW - elapsed).toISOString(), NOW)).toBe(expected);
  });

  it('uses the Arabic plural forms', () => {
    expect(timeAgo(ar, new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe('قبل ساعتين');
  });
});

describe('notificationTitle', () => {
  it.each([
    [item(), 'SLA breach · first response'],
    [
      item({ kind: 'sla_warning', detail: { clock: 'resolution', stepPercent: 80 } }),
      'SLA warning · resolution',
    ],
    [
      item({ kind: 'mentioned', actorName: 'Omar Nasser', detail: {} }),
      'Omar Nasser mentioned you',
    ],
    [item({ kind: 'mentioned', detail: {} }), 'Someone mentioned you'],
    [
      item({ kind: 'assigned', detail: { assignedBy: 'round_robin' } }),
      'Assigned to you by round-robin',
    ],
    [
      item({ kind: 'assigned', actorName: 'Lina', detail: { assignedBy: 'person' } }),
      'Assigned to you by Lina',
    ],
    [item({ kind: 'replied', detail: {} }), 'The contact replied'],
    [item({ kind: 'escalated', detail: {} }), 'Escalated to you or your team'],
  ])('titles %#', (notification, expected) => {
    expect(notificationTitle(t, notification)).toBe(expected);
  });
});

describe('notificationLine', () => {
  it('quotes a mention, measures a warning, and names the subject otherwise', () => {
    expect(notificationLine(t, item({ kind: 'mentioned', excerpt: '@Lina check?' }))).toBe(
      '“@Lina check?”',
    );
    expect(
      notificationLine(
        t,
        item({ kind: 'sla_warning', detail: { clock: 'resolution', stepPercent: 80 } }),
      ),
    ).toBe('80 % of the target used');
    expect(notificationLine(t, item())).toBe('Refund not received');
  });

  it("quotes a workflow rule's own message", () => {
    expect(
      notificationLine(
        t,
        item({
          kind: 'escalated',
          detail: { ruleId: '0199f4b2-9999-7000-8000-000000000001', message: 'VIP waiting' },
        }),
      ),
    ).toBe('“VIP waiting”');
  });
});

describe('notificationCaption', () => {
  it('says where and when, in the language on screen', () => {
    expect(notificationCaption(t, item({ kind: 'mentioned' }), 'en', NOW)).toBe(
      'Internal note · 2 min ago',
    );
    expect(
      notificationCaption(t, item({ kind: 'replied', messageChannel: 'email' }), 'en', NOW),
    ).toBe('Email · 2 min ago');
    expect(notificationCaption(t, item({ kind: 'assigned', detail: {} }), 'en', NOW)).toBe(
      'Billing · 2 min ago',
    );
    expect(notificationCaption(ar, item({ kind: 'assigned', detail: {} }), 'ar', NOW)).toBe(
      'الفوترة · قبل دقيقتين',
    );
    expect(
      notificationCaption(t, item({ kind: 'escalated', detail: { stepPercent: 120 } }), 'en', NOW),
    ).toBe('SLA step at 120 % · 2 min ago');
    expect(notificationCaption(t, item(), 'en', NOW)).toBe('2 min ago');
  });
});

describe('dayGroup and groupByDay', () => {
  it('groups by the reader calendar day, keeping the order', () => {
    const today = item({ id: 'a', createdAt: new Date(NOW - 3_600_000).toISOString() });
    const yesterday = item({ id: 'b', createdAt: new Date(NOW - 20 * 3_600_000).toISOString() });
    const earlier = item({ id: 'c', createdAt: new Date(NOW - 5 * 86_400_000).toISOString() });

    expect(dayGroup(today.createdAt, NOW)).toBe('today');
    expect(dayGroup(yesterday.createdAt, NOW)).toBe('yesterday');
    expect(
      groupByDay([today, yesterday, earlier], NOW).map(({ group, items }) => [group, items.length]),
    ).toEqual([
      ['today', 1],
      ['yesterday', 1],
      ['earlier', 1],
    ]);
  });
});

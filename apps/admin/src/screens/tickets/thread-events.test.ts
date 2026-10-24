import { createI18n } from '@helpdock/i18n';
import type { TicketActivityEntry } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { buildThread } from '../../tickets/thread.js';
import { describeEvent, type ThreadNames, type Translate } from './thread.js';

const names: ThreadNames = {
  nameFor: () => null,
  staffName: () => null,
  addressFor: () => null,
};
const en = createI18n({ lng: 'en' }).getFixedT('en') as unknown as Translate;
const ar = createI18n({ lng: 'ar' }).getFixedT('ar') as unknown as Translate;

it.each([
  ['en', en],
  ['ar', ar],
] as const)(
  'describes original source changes with preserved author/date in %s',
  (locale, translate) => {
    const source: TicketActivityEntry = {
      id: '0193b000-0000-7000-8000-000000000911',
      ticketId: '0193b000-0000-7000-8000-000000000913',
      actorType: 'system',
      actorId: 'import:zendesk:42',
      action: 'ticket.imported.event',
      via: 'system',
      createdAt: '2024-03-14T10:02:00Z',
      from: { field: 'status', value: 'open' },
      to: {
        changes: { field: 'status', value: 'closed' },
        sourceEvent: { source: 'zendesk', action: 'zendesk.Change', authorDisplay: 'Sara Ali' },
      },
    };
    expect(buildThread([], [source], [])).toMatchObject([{ kind: 'event', entry: source }]);
    const text = describeEvent(
      source,
      names,
      translate,
      locale,
      Date.parse('2026-10-15T00:00:00Z'),
    );
    expect(text).toContain('Sara Ali');
    expect(text).toContain('Zendesk');
    expect(text).toContain('open');
    expect(text).toContain('closed');
    expect(text).toContain('2024');
  },
);

const entry: TicketActivityEntry = {
  id: '0193b000-0000-7000-8000-000000000901',
  ticketId: '0193b000-0000-7000-8000-000000000903',
  actorType: 'visitor',
  actorId: '0193b000-0000-7000-8000-000000000902',
  action: 'ticket.source_article',
  from: null,
  to: {
    articleId: '0193b000-0000-7000-8000-000000000101',
    title: 'Refund timelines',
    locale: 'en',
  },
  via: 'ui',
  createdAt: '2026-09-27T09:41:00.000Z',
};

describe('the "Still need help?" line in the thread (M5-08)', () => {
  it('is drawn, as the one activity entry that says where the customer came from', () => {
    const items = buildThread([], [entry], []);

    expect(items).toMatchObject([{ kind: 'event', entry }]);
  });

  it('names the article in both languages', () => {
    const now = Date.parse('2026-09-27T10:00:00.000Z');

    expect(describeEvent(entry, names, en, 'en', now)).toMatch(
      /^Came from the help center article “Refund timelines” · /,
    );
    expect(describeEvent(entry, names, ar, 'ar', now)).toMatch(
      /^جاء من مقالة مركز المساعدة «Refund timelines» · /,
    );
  });
});

describe('the article proposal line in the thread (M7-05)', () => {
  const proposed: TicketActivityEntry = {
    ...entry,
    actorType: 'staff',
    action: 'ticket.article_proposed',
    to: { proposalId: '0193b000-0000-7000-8000-000000000904', title: 'Customs' },
  };

  it('is drawn, naming who sent the article for approval', () => {
    const now = Date.parse('2026-09-27T10:00:00.000Z');
    const lina: ThreadNames = { ...names, nameFor: () => 'Lina' };

    expect(buildThread([], [proposed], [])).toMatchObject([{ kind: 'event' }]);
    expect(describeEvent(proposed, lina, en, 'en', now)).toMatch(
      /^Lina proposed an article · waiting for approval · /,
    );
  });
});

describe('snooze activity (M14-02)', () => {
  const entry = (action: string, to: Record<string, unknown>): TicketActivityEntry => ({
    id: '0193b000-0000-7000-8000-000000000921',
    ticketId: '0193b000-0000-7000-8000-000000000913',
    actorType: 'staff',
    actorId: 'lina',
    action,
    via: 'ui',
    createdAt: '2026-10-21T10:00:00Z',
    from: null,
    to,
  });
  const NOW = Date.parse('2026-10-21T12:00:00Z');

  it('draws a snooze and its wake time in the thread, in both languages', () => {
    const snoozed = entry('ticket.snoozed', { snoozedUntil: '2026-10-25T09:00:00Z' });

    expect(buildThread([], [snoozed], [])).toMatchObject([{ kind: 'event' }]);
    expect(describeEvent(snoozed, names, en, 'en', NOW)).toContain('snoozed the ticket until');
    expect(describeEvent(snoozed, names, ar, 'ar', NOW)).toContain('أجّل');
  });

  it.each([
    ['time', 'its time came'],
    ['customer_reply', 'the customer replied'],
    ['sla', 'SLA was about to run out'],
    ['status_changed', 'its status changed'],
    ['manual', 'woke the ticket'],
  ])('says why a ticket woke: %s', (reason, text) => {
    const woke = entry('ticket.woke', { reason });

    expect(buildThread([], [woke], [])).toMatchObject([{ kind: 'event' }]);
    expect(describeEvent(woke, names, en, 'en', NOW)).toContain(text);
  });

  it('falls back to the time wake for a reason it does not know', () => {
    expect(
      describeEvent(entry('ticket.woke', { reason: 'later' }), names, en, 'en', NOW),
    ).toContain('its time came');
  });
});

describe('the closed-without line in the thread (M14-17)', () => {
  const activity = (action: string, to: Record<string, unknown>): TicketActivityEntry => ({
    id: `0193b000-0000-7000-8000-00000000${action.length}907`,
    ticketId: '0193b000-0000-7000-8000-000000000908',
    actorType: 'system',
    actorId: 'rule:0193b000-0000-7000-8000-000000000909',
    action,
    from: { statusId: '0193b000-0000-7000-8000-000000000910' },
    to: { statusId: '0193b000-0000-7000-8000-000000000911', ...to },
    via: 'rule',
    createdAt: '2026-10-01T10:00:00.000Z',
  });
  const closed = activity('ticket.closed', { closedWithout: ['loss_reason', 'carrier'] });
  const now = Date.parse('2026-10-01T10:01:00.000Z');
  const labelled: ThreadNames = {
    ...names,
    fieldLabel: (key) => ({ loss_reason: 'Loss reason', carrier: 'Carrier' })[key] ?? key,
  };

  it.each(['ticket.closed', 'ticket.merged', 'ticket.marked_spam'])(
    'draws a %s row that went without a field',
    (action) => {
      const row = activity(action, { closedWithout: ['loss_reason'] });

      expect(buildThread([], [row], [])).toMatchObject([{ kind: 'event', entry: row }]);
    },
  );

  it.each(['ticket.closed', 'ticket.merged', 'ticket.marked_spam'])(
    'leaves a plain %s row to the bubble or status line that already says it',
    (action) => {
      expect(buildThread([], [activity(action, {})], [])).toEqual([]);
      expect(buildThread([], [activity(action, { closedWithout: [] })], [])).toEqual([]);
    },
  );

  it('names the fields by label, joined in the language of the screen', () => {
    expect(describeEvent(closed, labelled, en, 'en', now)).toMatch(
      /^Someone closed the ticket without Loss reason and Carrier /,
    );
    expect(describeEvent(closed, labelled, ar, 'ar', now)).toMatch(/Loss reason و/);
  });

  it('shows the key for a field whose definition is not loaded', () => {
    expect(describeEvent(closed, names, en, 'en', now)).toMatch(/without loss_reason and carrier /);
  });

  it('draws an ordinary close when the detail carries no list', () => {
    expect(
      describeEvent({ ...closed, to: { statusId: closed.to?.statusId } }, names, en, 'en', now),
    ).not.toContain('without');
  });
});

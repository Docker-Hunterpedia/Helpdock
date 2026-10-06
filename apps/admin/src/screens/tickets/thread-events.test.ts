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

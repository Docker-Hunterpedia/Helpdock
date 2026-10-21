import { describe, expect, it } from 'vitest';
import { testStatus, testTicket } from './fixtures.js';
import { type BulkContext, planBulk, snapshotOf, undoPlan, updateOf } from './mock-bulk.js';

/**
 * The fixture's bulk rules (M14-04), which the browser suite and the screen
 * tests stand on: what would move, what a rule refuses, and what an Undo puts
 * back or leaves. The api's own rules are its integration suite.
 */

const OPEN = testStatus();
const CLOSED = testStatus({
  id: '0192c3f0-1a2b-7c3d-8e4f-000000000054',
  name: 'Closed',
  systemState: 'closed',
  isDefault: false,
});
const SPAM = testStatus({
  id: '0192c3f0-1a2b-7c3d-8e4f-000000000055',
  name: 'Spam',
  systemState: 'closed',
  isSpam: true,
  excludedFromReports: true,
  isDefault: false,
});
const SNOOZED = '0192c3f0-1a2b-7c3d-8e4f-000000000057';
const ME = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';

const context: BulkContext = { statuses: [OPEN, CLOSED, SPAM], meId: ME, snoozedStatusId: SNOOZED };

describe('planBulk', () => {
  it('moves a priority and says so', () => {
    const plan = planBulk(testTicket({ priority: 'high' }), { priority: 'low' }, context);

    expect(plan).toMatchObject({ outcome: 'will_change', fields: ['priority'] });
  });

  it('is unchanged when the ticket already has the value', () => {
    expect(planBulk(testTicket({ priority: 'low' }), { priority: 'low' }, context)).toEqual({
      outcome: 'unchanged',
    });
  });

  it('closes into the first closed status that is not spam, and is unchanged on a closed ticket', () => {
    const open = planBulk(testTicket(), { close: true }, context);
    const closed = planBulk(testTicket({ status: CLOSED }), { close: true }, context);

    expect(open).toMatchObject({ outcome: 'will_change', after: { statusId: CLOSED.id } });
    expect(closed).toEqual({ outcome: 'unchanged' });
  });

  it('marks spam into the spam status and names the field "spam"', () => {
    expect(planBulk(testTicket(), { spam: true }, context)).toMatchObject({
      fields: ['spam'],
      after: { statusId: SPAM.id },
    });
  });

  it('reads the assignee me as the person making the request', () => {
    expect(planBulk(testTicket(), { assigneeId: 'me' }, context)).toMatchObject({
      after: { assigneeId: ME },
    });
  });

  it('adds and removes tags as a set, and ignores one that is not there to remove', () => {
    const tagged = testTicket({ tags: [{ id: 't1', name: 'A', nameAr: null, color: 'info' }] });

    const plan = planBulk(tagged, { addTagIds: ['t2'], removeTagIds: ['t1', 't9'] }, context);

    expect(plan).toMatchObject({ fields: ['tags'], after: { tagIds: ['t2'] } });
  });

  it('moves the team, the department and one custom value', () => {
    const plan = planBulk(
      testTicket(),
      { teamId: 'team', departmentId: 'dept', customField: { key: 'tier', value: 'gold' } },
      context,
    );

    expect(plan).toMatchObject({
      outcome: 'will_change',
      fields: ['teamId', 'departmentId', 'custom'],
    });
  });

  it('refuses to snooze a closed ticket, and wakes only a snoozed one', () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();

    expect(planBulk(testTicket({ status: CLOSED }), { snoozedUntil: until }, context)).toEqual({
      outcome: 'refused',
      code: 'ticket-closed',
    });
    expect(planBulk(testTicket(), { snoozedUntil: null }, context)).toEqual({
      outcome: 'unchanged',
    });
    expect(
      planBulk(testTicket({ snoozedUntil: until }), { snoozedUntil: null }, context),
    ).toMatchObject({ fields: ['snoozedUntil'] });
  });

  it('snoozes into the Snoozed status', () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();

    expect(planBulk(testTicket(), { snoozedUntil: until }, context)).toMatchObject({
      fields: ['snoozedUntil'],
      after: { statusId: SNOOZED, snoozedUntil: until },
    });
  });

  it('refuses a merged ticket’s status and department, and lets its priority through', () => {
    const merged = testTicket({ mergedIntoId: 'primary' });

    expect(planBulk(merged, { close: true }, context)).toEqual({
      outcome: 'refused',
      code: 'ticket-merged',
    });
    expect(planBulk(merged, { departmentId: 'dept' }, context)).toMatchObject({
      code: 'ticket-merged',
    });
    expect(planBulk(merged, { priority: 'low' }, context).outcome).toBe('will_change');
  });
});

describe('updateOf', () => {
  it('asks for the fields that moved and nothing else', () => {
    const changes = { priority: 'low' as const, assigneeId: 'me' };
    const plan = planBulk(testTicket({ priority: 'high' }), changes, context);
    if (plan.outcome !== 'will_change') {
      throw new Error('expected a change');
    }

    expect(updateOf(plan, changes)).toEqual({ priority: 'low', assigneeId: ME });
  });

  it('sends a snooze as snoozedUntil and not as a status', () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const changes = { snoozedUntil: until };
    const plan = planBulk(testTicket(), changes, context);
    if (plan.outcome !== 'will_change') {
      throw new Error('expected a change');
    }

    expect(updateOf(plan, changes)).toEqual({ snoozedUntil: until });
  });

  it('sends a custom value as a patch', () => {
    const changes = { customField: { key: 'tier', value: 'gold' } };
    const plan = planBulk(testTicket(), changes, context);
    if (plan.outcome !== 'will_change') {
      throw new Error('expected a change');
    }

    expect(updateOf(plan, changes)).toEqual({ custom: { tier: 'gold' } });
  });
});

describe('undoPlan', () => {
  const before = snapshotOf(testTicket({ priority: 'high' }));
  const after = { ...before, priority: 'low' as const, assigneeId: ME, tagIds: ['t2'] };

  it('puts back every field that is still what the operation set', () => {
    const current = { ...after };

    const plan = undoPlan(current, before, after, ['priority', 'assigneeId', 'tags']);

    expect(plan.reverted).toEqual(['priority', 'assigneeId', 'tags']);
    expect(plan.kept).toEqual([]);
    expect(plan.update).toEqual({ priority: 'high', assigneeId: null });
    expect(plan.tagIds).toEqual([]);
  });

  it('keeps a field somebody changed since', () => {
    const current = { ...after, priority: 'urgent' as const };

    const plan = undoPlan(current, before, after, ['priority', 'assigneeId']);

    expect(plan.kept).toEqual(['priority']);
    expect(plan.reverted).toEqual(['assigneeId']);
    expect(plan.update).toEqual({ assigneeId: null });
  });

  it('puts back a status, a team, a department and a snooze, and keeps each that moved', () => {
    const start = {
      ...before,
      statusId: 's1',
      teamId: 'a',
      departmentId: 'd1',
      snoozedUntil: null,
    };
    const set = { ...start, statusId: 's2', teamId: 'b', departmentId: 'd2', snoozedUntil: 'x' };

    const all = undoPlan(set, start, set, ['statusId', 'teamId', 'departmentId', 'snoozedUntil']);
    const moved = undoPlan(
      { ...set, statusId: 's9', teamId: 'z', departmentId: 'd9', snoozedUntil: 'y' },
      start,
      set,
      ['statusId', 'teamId', 'departmentId', 'snoozedUntil', 'spam', 'custom'],
    );

    expect(all.update).toEqual({
      statusId: 's1',
      teamId: 'a',
      departmentId: 'd1',
      snoozedUntil: null,
    });
    expect(moved.reverted).toEqual([]);
    expect(moved.kept).toEqual([
      'statusId',
      'teamId',
      'departmentId',
      'snoozedUntil',
      'spam',
      'custom',
    ]);
  });

  it('keeps tags that were changed since, as a set', () => {
    const current = { ...after, tagIds: ['t2', 't3'] };

    const plan = undoPlan(current, before, after, ['tags']);

    expect(plan.kept).toEqual(['tags']);
    expect(plan.tagIds).toBeNull();
  });
});

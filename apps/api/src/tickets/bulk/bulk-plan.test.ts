import type { BulkChanges } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  fieldOf,
  fieldsOf,
  itemDiff,
  normaliseInstant,
  planUndo,
  sortedTagIds,
  type TicketSnapshot,
  tagsAfter,
  updateFor,
} from './bulk-plan.js';

const ADA = '0199f4b2-1111-7000-8000-000000000001';
const CY = '0199f4b2-1111-7000-8000-000000000002';
const OPEN = '0199f4b2-5555-7000-8000-000000000001';
const CLOSED = '0199f4b2-5555-7000-8000-000000000002';
const SNOOZED = '0199f4b2-5555-7000-8000-000000000003';
const SUPPORT = '0199f4b2-3333-7000-8000-0000000000d1';
const BILLING = '0199f4b2-3333-7000-8000-0000000000d2';
const TAG_A = '0199f4b2-6666-7000-8000-00000000000a';
const TAG_B = '0199f4b2-6666-7000-8000-00000000000b';
const TAG_C = '0199f4b2-6666-7000-8000-00000000000c';
const UNTIL = '2026-10-21T12:00:00.000Z';

const snapshot = (overrides: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  statusId: OPEN,
  priority: 'medium',
  assigneeId: null,
  teamId: null,
  departmentId: SUPPORT,
  snoozedUntil: null,
  tagIds: [],
  custom: null,
  ...overrides,
});

describe('updateFor', () => {
  const context = { actorId: ADA, closedStatusId: CLOSED };

  it('turns the changes into the body a single edit takes', () => {
    expect(
      updateFor({ priority: 'high', teamId: null, departmentId: BILLING, assigneeId: CY }, context),
    ).toEqual({ priority: 'high', teamId: null, departmentId: BILLING, assigneeId: CY });
  });

  it('reads me as the person making the request, and null as nobody', () => {
    expect(updateFor({ assigneeId: 'me' }, context)).toEqual({ assigneeId: ADA });
    expect(updateFor({ assigneeId: null }, context)).toEqual({ assigneeId: null });
  });

  it('moves close to the brand’s Closed status', () => {
    expect(updateFor({ close: true }, context)).toEqual({ statusId: CLOSED });
  });

  it('passes a snooze or a wake through as snoozedUntil', () => {
    expect(updateFor({ snoozedUntil: UNTIL }, context)).toEqual({ snoozedUntil: UNTIL });
    expect(updateFor({ snoozedUntil: null }, context)).toEqual({ snoozedUntil: null });
  });

  it('writes one custom field value, and clears it with null', () => {
    expect(updateFor({ customField: { key: 'order_ref', value: 'A-1' } }, context)).toEqual({
      custom: { order_ref: 'A-1' },
    });
    expect(updateFor({ customField: { key: 'order_ref', value: undefined } }, context)).toEqual({
      custom: { order_ref: null },
    });
  });

  it('asks nothing of the ticket row for tags and spam, which have their own paths', () => {
    expect(updateFor({ addTagIds: [TAG_A], spam: true }, context)).toBeUndefined();
  });
});

describe('tagsAfter', () => {
  it('adds and removes against what the ticket carries', () => {
    expect(tagsAfter({ addTagIds: [TAG_C], removeTagIds: [TAG_A] }, [TAG_A, TAG_B])).toEqual([
      TAG_B,
      TAG_C,
    ]);
  });

  it('adds a tag the ticket already has without repeating it', () => {
    expect(tagsAfter({ addTagIds: [TAG_A] }, [TAG_A])).toEqual([TAG_A]);
  });

  it('leaves tags alone when the changes do not name any', () => {
    expect(tagsAfter({ priority: 'high' }, [TAG_A])).toBeUndefined();
  });
});

describe('itemDiff', () => {
  const none: BulkChanges = {};

  it('keeps only what moved, before and after', () => {
    const diff = itemDiff(
      snapshot(),
      snapshot({ priority: 'high', assigneeId: CY, tagIds: [TAG_A] }),
      none,
    );

    expect(diff).toEqual({
      before: { priority: 'medium', assigneeId: null, tagIds: [] },
      after: { priority: 'high', assigneeId: CY, tagIds: [TAG_A] },
    });
  });

  it('is empty when nothing moved', () => {
    expect(itemDiff(snapshot(), snapshot(), none)).toEqual({ before: {}, after: {} });
  });

  it('records a snooze by its wake time and not by the status it implies', () => {
    const diff = itemDiff(snapshot(), snapshot({ statusId: SNOOZED, snoozedUntil: UNTIL }), {
      snoozedUntil: UNTIL,
    });

    expect(diff).toEqual({ before: { snoozedUntil: null }, after: { snoozedUntil: UNTIL } });
  });

  it('records any other status change by the status, not the snooze it cleared', () => {
    const diff = itemDiff(
      snapshot({ statusId: SNOOZED, snoozedUntil: UNTIL }),
      snapshot({ statusId: CLOSED }),
      { close: true },
    );

    expect(diff).toEqual({ before: { statusId: SNOOZED }, after: { statusId: CLOSED } });
  });

  it('compares a custom value by content', () => {
    const same = itemDiff(snapshot({ custom: ['a'] }), snapshot({ custom: ['a'] }), none);
    const moved = itemDiff(snapshot({ custom: 'a' }), snapshot({ custom: 'b' }), none);

    expect(same.after).toEqual({});
    expect(moved).toEqual({ before: { custom: 'a' }, after: { custom: 'b' } });
  });

  it('records the assignee a department move dropped', () => {
    const diff = itemDiff(
      snapshot({ assigneeId: CY }),
      snapshot({ assigneeId: null, departmentId: BILLING }),
      { departmentId: BILLING },
    );

    expect(diff.after).toEqual({ assigneeId: null, departmentId: BILLING });
  });
});

describe('field names', () => {
  it('names a status move made by Mark spam spam, and tags tags', () => {
    expect(fieldOf('statusId', { spam: true })).toBe('spam');
    expect(fieldOf('statusId', { close: true })).toBe('statusId');
    expect(fieldOf('tagIds', {})).toBe('tags');
    expect(fieldsOf({ priority: 'high', tagIds: [TAG_A] }, {})).toEqual(['priority', 'tags']);
  });
});

describe('planUndo', () => {
  const customKey = 'order_ref';

  it('puts back each field still holding the operation’s value', () => {
    const plan = planUndo(
      {
        before: { priority: 'medium', assigneeId: null },
        after: { priority: 'high', assigneeId: CY },
      },
      snapshot({ priority: 'high', assigneeId: CY }),
      { priority: 'high', assigneeId: CY },
      undefined,
    );

    expect(plan).toEqual({
      update: { priority: 'medium', assigneeId: null },
      tagIds: undefined,
      reverted: ['priority', 'assigneeId'],
      kept: [],
    });
  });

  it('keeps and reports a field somebody changed since, and still reverts the rest', () => {
    const plan = planUndo(
      {
        before: { priority: 'medium', assigneeId: null },
        after: { priority: 'high', assigneeId: CY },
      },
      snapshot({ priority: 'low', assigneeId: CY }),
      { priority: 'high', assigneeId: CY },
      undefined,
    );

    expect(plan.update).toEqual({ assigneeId: null });
    expect(plan.reverted).toEqual(['assigneeId']);
    expect(plan.kept).toEqual(['priority']);
  });

  it('wakes a ticket that is still asleep for the time the operation set', () => {
    const plan = planUndo(
      { before: { snoozedUntil: null }, after: { snoozedUntil: UNTIL } },
      snapshot({ statusId: SNOOZED, snoozedUntil: UNTIL }),
      { snoozedUntil: UNTIL },
      undefined,
    );

    expect(plan.update).toEqual({ snoozedUntil: null });
  });

  it('leaves a snooze that was moved since', () => {
    const plan = planUndo(
      { before: { snoozedUntil: null }, after: { snoozedUntil: UNTIL } },
      snapshot({ statusId: SNOOZED, snoozedUntil: '2026-10-22T09:00:00.000Z' }),
      { snoozedUntil: UNTIL },
      undefined,
    );

    expect(plan.update).toBeUndefined();
    expect(plan.kept).toEqual(['snoozedUntil']);
  });

  it('takes tags off as a set, leaving one a colleague added and restoring one still gone', () => {
    const plan = planUndo(
      { before: { tagIds: [TAG_A] }, after: { tagIds: [TAG_B] } },
      snapshot({ tagIds: sortedTagIds([TAG_B, TAG_C]) }),
      { addTagIds: [TAG_B], removeTagIds: [TAG_A] },
      undefined,
    );

    expect(plan.tagIds).toEqual(sortedTagIds([TAG_A, TAG_C]));
    expect(plan.reverted).toEqual(['tags']);
  });

  it('keeps tags when there is nothing of the operation left to take back', () => {
    const plan = planUndo(
      { before: { tagIds: [TAG_A] }, after: { tagIds: [TAG_B] } },
      snapshot({ tagIds: [TAG_A] }),
      { addTagIds: [TAG_B], removeTagIds: [TAG_A] },
      undefined,
    );

    expect(plan.tagIds).toBeUndefined();
    expect(plan.kept).toEqual(['tags']);
  });

  it('puts a custom value back by its key, clearing one that was empty', () => {
    const plan = planUndo(
      { before: { custom: null }, after: { custom: 'A-1' } },
      snapshot({ custom: 'A-1' }),
      { customField: { key: customKey, value: 'A-1' } },
      customKey,
    );

    expect(plan.update).toEqual({ custom: { order_ref: null } });
  });

  it('names a spam undo spam', () => {
    const plan = planUndo(
      { before: { statusId: OPEN }, after: { statusId: CLOSED } },
      snapshot({ statusId: CLOSED }),
      { spam: true },
      undefined,
    );

    expect(plan.reverted).toEqual(['spam']);
    expect(plan.update).toEqual({ statusId: OPEN });
  });
});

describe('normaliseInstant', () => {
  it('writes the same instant one way, and null for none', () => {
    expect(normaliseInstant(new Date(UNTIL))).toBe(UNTIL);
    expect(normaliseInstant('2026-10-21T14:00:00+02:00')).toBe(UNTIL);
    expect(normaliseInstant(null)).toBeNull();
    expect(normaliseInstant(undefined)).toBeNull();
  });
});

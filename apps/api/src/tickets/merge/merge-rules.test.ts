import type { Attachment as AttachmentRow, TicketMessage as TicketMessageRow } from '@helpdock/db';
import { UNMERGE_WINDOW_MS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  addedContact,
  closedAtOnMerge,
  closedAtOnUnmerge,
  copyableAttachments,
  type MergeSide,
  mergedDuration,
  mergeRefusal,
  splitSelection,
  unmergeableUntil,
  unmergeRefusal,
} from './merge-rules.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const PRIMARY = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
const SECONDARY = '0192c3f0-1a2b-7c3d-8e4f-0000000000a2';
const ELSEWHERE = '0192c3f0-1a2b-7c3d-8e4f-0000000000a3';

const side = (id: string, facts: Partial<MergeSide> = {}): MergeSide => ({
  id,
  systemState: 'open',
  mergedIntoId: null,
  deletedAt: null,
  ...facts,
});

const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('mergeRefusal', () => {
  it('lets an open ticket close into another', () => {
    expect(mergeRefusal(side(SECONDARY), side(PRIMARY))).toBeNull();
  });

  it('lets a closed ticket be merged, and be merged into (DOMAIN-RULES §2.2: "any")', () => {
    expect(
      mergeRefusal(
        side(SECONDARY, { systemState: 'closed' }),
        side(PRIMARY, { systemState: 'closed' }),
      ),
    ).toBeNull();
  });

  it('refuses a ticket merged into itself', () => {
    expect(mergeRefusal(side(PRIMARY), side(PRIMARY))).toBe('merge-into-self');
  });

  it('refuses a secondary that is already merged: unmerge is the only way back', () => {
    expect(mergeRefusal(side(SECONDARY, { mergedIntoId: ELSEWHERE }), side(PRIMARY))).toBe(
      'ticket-merged',
    );
  });

  it('refuses a deleted secondary', () => {
    expect(mergeRefusal(side(SECONDARY, { deletedAt: NOW }), side(PRIMARY))).toBe('ticket-deleted');
  });

  it('refuses a primary that is itself merged, which is also what rules out a cycle', () => {
    expect(mergeRefusal(side(SECONDARY), side(PRIMARY, { mergedIntoId: SECONDARY }))).toBe(
      'merge-into-merged',
    );
  });
});

describe('unmergeableUntil', () => {
  it('is 24 hours after the merge while those have not passed', () => {
    expect(unmergeableUntil(ago(60_000), NOW)?.getTime()).toBe(
      NOW.getTime() - 60_000 + UNMERGE_WINDOW_MS,
    );
  });

  it('is null once they have, and at the very instant they do', () => {
    expect(unmergeableUntil(ago(UNMERGE_WINDOW_MS), NOW)).toBeNull();
    expect(unmergeableUntil(ago(UNMERGE_WINDOW_MS + 1), NOW)).toBeNull();
  });

  it('is null for a ticket that is not merged', () => {
    expect(unmergeableUntil(null, NOW)).toBeNull();
  });
});

describe('unmergeRefusal', () => {
  it('allows an unmerge one millisecond before the window closes', () => {
    expect(
      unmergeRefusal({ mergedIntoId: PRIMARY, mergedAt: ago(UNMERGE_WINDOW_MS - 1) }, NOW),
    ).toBeNull();
  });

  it('refuses an unmerge after 24 hours', () => {
    expect(unmergeRefusal({ mergedIntoId: PRIMARY, mergedAt: ago(UNMERGE_WINDOW_MS) }, NOW)).toBe(
      'merge-window-closed',
    );
  });

  it('refuses to unmerge a ticket that is not merged', () => {
    expect(unmergeRefusal({ mergedIntoId: null, mergedAt: null }, NOW)).toBe('ticket-not-merged');
  });
});

describe('closed_at across a merge and back', () => {
  it('closes an open secondary at the moment of the merge', () => {
    expect(closedAtOnMerge(null, NOW)).toBe(NOW);
  });

  it('keeps the closed_at of a secondary that was already closed', () => {
    const earlier = ago(3_600_000);

    expect(closedAtOnMerge(earlier, NOW)).toBe(earlier);
  });

  it('clears closed_at when the restored status is open-like', () => {
    expect(closedAtOnUnmerge({ systemState: 'on_hold' }, NOW)).toBeNull();
  });

  it('keeps closed_at when the restored status is itself closed', () => {
    expect(closedAtOnUnmerge({ systemState: 'closed' }, NOW)).toBe(NOW);
  });
});

describe('mergedDuration', () => {
  it('is the time between the merge and the unmerge', () => {
    expect(mergedDuration(ago(90_000), NOW)).toBe(90_000);
  });

  it('is never negative, whatever a clock skew says', () => {
    expect(mergedDuration(new Date(NOW.getTime() + 5), NOW)).toBe(0);
  });
});

const message = (id: string, seq: number, kind: TicketMessageRow['kind'] = 'public') =>
  ({ id, seq, kind }) as TicketMessageRow;

const attachment = (status: AttachmentRow['status']) => ({ status }) as AttachmentRow;

describe('splitSelection', () => {
  const first = message('m1', 1);
  const second = message('m2', 2);

  it('returns the messages oldest first, whatever order they were ticked in', () => {
    const selection = splitSelection(['m2', 'm1'], [second, first], new Map());

    expect(selection).toEqual({ ok: true, messages: [first, second] });
  });

  it('copies a message named twice once', () => {
    const selection = splitSelection(['m1', 'm1'], [first], new Map());

    expect(selection).toEqual({ ok: true, messages: [first] });
  });

  it('refuses an id that is not a message of this ticket, rather than skipping it', () => {
    expect(splitSelection(['m1', 'elsewhere'], [first], new Map())).toEqual({
      ok: false,
      problem: 'not_found',
    });
  });

  it('refuses a system message', () => {
    expect(splitSelection(['s'], [message('s', 3, 'system')], new Map())).toEqual({
      ok: false,
      problem: 'system_message',
    });
  });

  it('refuses a message whose attachment is still being processed', () => {
    const files = new Map([['m1', [attachment('ready'), attachment('processing')]]]);

    expect(splitSelection(['m1'], [first], files)).toEqual({
      ok: false,
      problem: 'attachments-in-flight',
    });
  });

  it('allows a message whose attachments were refused by the pipeline', () => {
    const files = new Map([['m1', [attachment('rejected'), attachment('infected')]]]);

    expect(splitSelection(['m1'], [first], files).ok).toBe(true);
  });
});

describe('copyableAttachments', () => {
  it('copies only what a reader could open', () => {
    const ready = attachment('ready');

    expect(copyableAttachments([ready, attachment('rejected'), attachment('infected')])).toEqual([
      ready,
    ]);
  });
});

describe('addedContact', () => {
  it('adds the secondary\u2019s contact when it is somebody else', () => {
    expect(addedContact({ contactId: PRIMARY }, { contactId: SECONDARY })).toBe(SECONDARY);
  });

  it('adds nobody for the same person, or for a secondary with no contact', () => {
    expect(addedContact({ contactId: PRIMARY }, { contactId: PRIMARY })).toBeNull();
    expect(addedContact({ contactId: PRIMARY }, { contactId: null })).toBeNull();
  });

  it('adds the secondary\u2019s contact to a primary that has none', () => {
    expect(addedContact({ contactId: null }, { contactId: SECONDARY })).toBe(SECONDARY);
  });
});

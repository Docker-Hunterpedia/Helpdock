import type { BulkResponse } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { AuthError } from '../auth/api.js';
import { ContactError } from '../contacts/api.js';
import { TicketingError } from '../ticketing/api.js';
import { TicketLifecycleError } from './api.js';
import {
  type BlockReason,
  type BulkChoice,
  changesOf,
  dialogKindOf,
  failureOf,
  missingFieldsSentence,
  reasonKey,
  summarise,
  toastKindOf,
} from './bulk.js';

const response = (results: BulkResponse['results']): BulkResponse => ({
  mode: 'preview',
  results,
  counts: { willChange: 0, unchanged: 0, refused: 0, notFound: 0 },
  operationId: null,
  undoUntil: null,
});

describe('changesOf', () => {
  it.each<[BulkChoice, object]>([
    [{ kind: 'status', statusId: 's1' }, { statusId: 's1' }],
    [{ kind: 'close' }, { close: true }],
    [{ kind: 'priority', priority: 'high' }, { priority: 'high' }],
    [{ kind: 'assignee', assigneeId: 'me' }, { assigneeId: 'me' }],
    [{ kind: 'assignee', assigneeId: null }, { assigneeId: null }],
    [{ kind: 'team', teamId: null }, { teamId: null }],
    [{ kind: 'department', departmentId: 'd1' }, { departmentId: 'd1' }],
    [{ kind: 'snooze', until: null }, { snoozedUntil: null }],
    [{ kind: 'spam' }, { spam: true }],
    [
      { kind: 'field', key: 'order_id', value: 'A1' },
      { customField: { key: 'order_id', value: 'A1' } },
    ],
  ])('turns %j into the api’s change', (choice, expected) => {
    expect(changesOf(choice)).toEqual(expected);
  });

  it('sends only the tag lists that have something in them', () => {
    expect(changesOf({ kind: 'tags', addTagIds: ['a'], removeTagIds: [] })).toEqual({
      addTagIds: ['a'],
    });
    expect(changesOf({ kind: 'tags', addTagIds: [], removeTagIds: ['b'] })).toEqual({
      removeTagIds: ['b'],
    });
  });
});

describe('summarise', () => {
  it('splits what will change from everything that will not, keeping the order', () => {
    const summary = summarise(
      response([
        { ticketId: 'a', outcome: 'will_change', fields: ['statusId'], code: null },
        { ticketId: 'b', outcome: 'refused', fields: [], code: 'ticket-closed' },
        { ticketId: 'c', outcome: 'unchanged', fields: [], code: null },
        { ticketId: 'd', outcome: 'not_found', fields: [], code: null },
        { ticketId: 'e', outcome: 'will_change', fields: ['priority'], code: null },
      ]),
    );

    expect(summary).toEqual({
      total: 5,
      changing: ['a', 'e'],
      blockers: [
        { ticketId: 'b', reason: { kind: 'refused', code: 'ticket-closed' } },
        { ticketId: 'c', reason: { kind: 'unchanged' } },
        { ticketId: 'd', reason: { kind: 'notFound' } },
      ],
    });
  });

  it('keeps the fields a close is waiting for (M14-17)', () => {
    const missing = [{ key: 'order_id', label: 'Order id', labelAr: null }];
    const summary = summarise(
      response([
        {
          ticketId: 'b',
          outcome: 'refused',
          fields: [],
          code: 'fields-required-to-close',
          missing,
        },
      ]),
    );

    expect(summary.blockers[0]?.reason).toEqual({
      kind: 'refused',
      code: 'fields-required-to-close',
      missing,
    });
  });

  it('reads a refusal without a code as the generic one', () => {
    const summary = summarise(
      response([{ ticketId: 'b', outcome: 'refused', fields: [], code: null }]),
    );

    expect(summary.blockers[0]?.reason).toEqual({ kind: 'refused', code: 'other' });
  });
});

describe('reasonKey', () => {
  const close: BulkChoice = { kind: 'close' };
  const priority: BulkChoice = { kind: 'priority', priority: 'low' };

  it('says "Already closed" only for a close', () => {
    expect(reasonKey({ kind: 'unchanged' }, close)).toBe('bulk.reason.unchangedClose');
    expect(reasonKey({ kind: 'unchanged' }, priority)).toBe('bulk.reason.unchanged');
  });

  it('names a refusal the catalog knows and falls back for one it does not', () => {
    expect(reasonKey({ kind: 'refused', code: 'ticket-closed' }, priority)).toBe(
      'bulk.reason.ticket-closed',
    );
    expect(reasonKey({ kind: 'refused', code: 'a-new-code' }, priority)).toBe('bulk.reason.other');
  });

  it('says a ticket the person cannot see is no longer available', () => {
    expect(reasonKey({ kind: 'notFound' }, priority)).toBe('bulk.reason.notFound');
  });
});

describe('wording kinds', () => {
  it('gives closing its own dialog and every other choice the shared one', () => {
    expect(dialogKindOf({ kind: 'close' })).toBe('close');
    expect(dialogKindOf({ kind: 'spam' })).toBe('change');
  });

  it.each<[BulkChoice, string]>([
    [{ kind: 'close' }, 'close'],
    [{ kind: 'spam' }, 'spam'],
    [{ kind: 'snooze', until: '2026-10-25T09:00:00.000Z' }, 'snooze'],
    [{ kind: 'snooze', until: null }, 'changed'],
    [{ kind: 'assignee', assigneeId: null }, 'assign'],
    [{ kind: 'priority', priority: 'high' }, 'changed'],
  ])('words the toast of %j as %s', (choice, expected) => {
    expect(toastKindOf(choice)).toBe(expected);
  });
});

describe('failureOf', () => {
  it('reads the 409 as "preview again"', () => {
    expect(failureOf(new TicketLifecycleError('bulk-changed'))).toEqual({ kind: 'changed' });
  });

  it('reads the 429 with its wait', () => {
    expect(failureOf(new AuthError('rate-limited', { retryAfter: 30, status: 429 }))).toEqual({
      kind: 'rateLimited',
      retryAfter: 30,
    });
  });

  it('reads the undo refusals', () => {
    expect(failureOf(new TicketLifecycleError('bulk-undo-expired'))).toEqual({ kind: 'expired' });
    expect(failureOf(new TicketLifecycleError('bulk-already-undone'))).toEqual({
      kind: 'alreadyUndone',
    });
  });

  it('reads anything else as a failure', () => {
    expect(failureOf(new TicketLifecycleError('ticket-merged'))).toEqual({ kind: 'failed' });
    expect(failureOf(new AuthError('invalid-credentials'))).toEqual({ kind: 'failed' });
    expect(failureOf(new AuthError('unavailable', { status: 403 }))).toEqual({ kind: 'failed' });
  });

  it('takes any coded refusal the transport builds as the api saying no', () => {
    expect(failureOf(new TicketingError('assignee-above-actor'))).toEqual({ kind: 'failed' });
    expect(failureOf(new ContactError('merge-self'))).toEqual({ kind: 'failed' });
  });

  it('does not know what happened when no answer the api stands behind came back', () => {
    expect(failureOf(new AuthError('unavailable'))).toEqual({ kind: 'unknown' });
    expect(failureOf(new AuthError('unavailable', { status: 502 }))).toEqual({ kind: 'unknown' });
    expect(failureOf(new Error('boom'))).toEqual({ kind: 'unknown' });
    expect(failureOf(new TypeError('Failed to fetch'))).toEqual({ kind: 'unknown' });
    expect(failureOf(new SyntaxError('Unexpected token <'))).toEqual({ kind: 'unknown' });
    expect(failureOf(Object.assign(new Error('bad'), { name: 'ZodError' }))).toEqual({
      kind: 'unknown',
    });
    expect(failureOf('a string')).toEqual({ kind: 'unknown' });
  });
});

describe('missingFieldsSentence (M14-17)', () => {
  const t = (key: string, options?: Record<string, unknown>): string =>
    key === 'tickets:bulk.reason.fieldQuote'
      ? `“${String(options?.label)}”`
      : `${String(options?.fields)} must be filled in`;

  it('joins the quoted labels in the viewer’s language', () => {
    const reason: BlockReason = {
      kind: 'refused',
      code: 'fields-required-to-close',
      missing: [
        { key: 'a', label: 'Order id', labelAr: 'رقم' },
        { key: 'b', label: 'Cause', labelAr: null },
      ],
    };

    expect(missingFieldsSentence(reason, 'en', t)).toBe('“Order id” and “Cause” must be filled in');
    expect(missingFieldsSentence(reason, 'ar', t)).toContain('“رقم”');
  });

  it('is null when nothing names a field, so the code’s own sentence stands', () => {
    expect(missingFieldsSentence({ kind: 'unchanged' }, 'en', t)).toBeNull();
    expect(
      missingFieldsSentence({ kind: 'refused', code: 'fields-required-to-close' }, 'en', t),
    ).toBeNull();
    expect(
      missingFieldsSentence(
        { kind: 'refused', code: 'fields-required-to-close', missing: [] },
        'en',
        t,
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { BULK_MAX_TICKETS, bulkChangesSchema, bulkRequestSchema } from './ticket-bulk.js';

const ID = '0199f4b2-1111-7000-8000-000000000001';
const OTHER = '0199f4b2-1111-7000-8000-000000000002';
const TAG = '0199f4b2-6666-7000-8000-00000000000a';

const request = (overrides: Record<string, unknown> = {}) => ({
  ticketIds: [ID],
  changes: { priority: 'high' },
  mode: 'preview',
  ...overrides,
});

describe('bulkChangesSchema', () => {
  it.each([
    ['a priority', { priority: 'high' }],
    ['an assignee of me', { assigneeId: 'me' }],
    ['nobody', { assigneeId: null }],
    ['a wake', { snoozedUntil: null }],
    ['a close with a priority', { close: true, priority: 'low' }],
    ['tags to add and others to remove', { addTagIds: [TAG], removeTagIds: [ID] }],
    ['one custom value', { customField: { key: 'order_ref', value: 'A-1' } }],
  ])('accepts %s', (_name, changes) => {
    expect(bulkChangesSchema.safeParse(changes).success).toBe(true);
  });

  it.each([
    ['nothing', {}],
    ['a reply', { reply: 'hello' }],
    ['a delete', { delete: true }],
    ['a merge', { mergeInto: ID }],
    ['two transitions', { close: true, snoozedUntil: null }],
    ['a close and a spam mark', { close: true, spam: true }],
    ['a status and a snooze', { statusId: ID, snoozedUntil: null }],
    ['a tag added and removed', { addTagIds: [TAG], removeTagIds: [TAG] }],
    ['a block-sender flag', { spam: true, blockSender: true }],
    ['two custom values', { customField: [{ key: 'a', value: 1 }] }],
    ['an empty tag list', { addTagIds: [] }],
    ['a close that is false', { close: false }],
  ])('refuses %s', (_name, changes) => {
    expect(bulkChangesSchema.safeParse(changes).success).toBe(false);
  });
});

describe('bulkRequestSchema', () => {
  it('accepts a preview, and an apply that names what to expect', () => {
    expect(bulkRequestSchema.safeParse(request()).success).toBe(true);
    expect(bulkRequestSchema.safeParse(request({ mode: 'apply', expect: [ID] })).success).toBe(
      true,
    );
  });

  it('accepts the cap and refuses one more', () => {
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_value, index) => `0199f4b2-1111-7000-8000-${String(index).padStart(12, '0')}`,
      );

    expect(bulkRequestSchema.safeParse(request({ ticketIds: ids(BULK_MAX_TICKETS) })).success).toBe(
      true,
    );
    expect(
      bulkRequestSchema.safeParse(request({ ticketIds: ids(BULK_MAX_TICKETS + 1) })).success,
    ).toBe(false);
    expect(bulkRequestSchema.safeParse(request({ ticketIds: [] })).success).toBe(false);
  });

  it.each([
    ['repeated ids', request({ ticketIds: [ID, ID] })],
    ['an apply without expect', request({ mode: 'apply' })],
    ['a preview with expect', request({ expect: [ID] })],
    ['an expect outside the ids', request({ mode: 'apply', expect: [OTHER] })],
    ['an unknown mode', request({ mode: 'dry-run' })],
    ['a stray key', request({ force: true })],
    ['a ticket id that is not an id', request({ ticketIds: ['HD-1'] })],
  ])('refuses %s', (_name, body) => {
    expect(bulkRequestSchema.safeParse(body).success).toBe(false);
  });
});

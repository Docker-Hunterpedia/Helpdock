import { describe, expect, it } from 'vitest';
import { ticketMergeRequestSchema, ticketSplitRequestSchema } from './merge.js';
import { TICKET_PAGE_SIZE_MAX, ticketDetailSchema } from './ticket.js';

const ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const OTHER = '0192c3f0-1a2b-7c3d-8e4f-000000000002';

describe('ticketMergeRequestSchema', () => {
  it('names the primary by id and nothing else', () => {
    expect(ticketMergeRequestSchema.parse({ primaryTicketId: ID })).toEqual({
      primaryTicketId: ID,
    });
    expect(ticketMergeRequestSchema.safeParse({ primaryTicketId: 'HD-1042' }).success).toBe(false);
  });
});

describe('ticketSplitRequestSchema', () => {
  const valid = { messageIds: [ID], subject: 'Invoice VAT', departmentId: OTHER };

  it('leaves the priority to the original when it is not named', () => {
    expect(ticketSplitRequestSchema.parse(valid).priority).toBeUndefined();
  });

  it('refuses a split that copies nothing', () => {
    expect(ticketSplitRequestSchema.safeParse({ ...valid, messageIds: [] }).success).toBe(false);
  });

  it('refuses more messages than one page of a thread', () => {
    const messageIds = Array.from({ length: TICKET_PAGE_SIZE_MAX + 1 }, () => ID);

    expect(ticketSplitRequestSchema.safeParse({ ...valid, messageIds }).success).toBe(false);
  });

  it('refuses a subject that is only whitespace', () => {
    expect(ticketSplitRequestSchema.safeParse({ ...valid, subject: '   ' }).success).toBe(false);
  });
});

describe('ticketDetailSchema, merge fields', () => {
  it('still parses a detail from before merge existed', () => {
    const detail = ticketDetailSchema.shape;

    expect(detail.merged.safeParse(undefined).success).toBe(true);
    expect(detail.mergedInto.safeParse(undefined).success).toBe(true);
    expect(detail.related.safeParse(undefined).success).toBe(true);
  });

  it('reads a merged-into link with an expired window as null, not absent', () => {
    const parsed = ticketDetailSchema.shape.mergedInto.parse({
      id: ID,
      number: 1038,
      prefix: 'HD',
      subject: 'Refund',
      mergedAt: '2026-09-20T10:00:00.000Z',
      mergedById: null,
      unmergeableUntil: null,
    });

    expect(parsed?.unmergeableUntil).toBeNull();
  });
});

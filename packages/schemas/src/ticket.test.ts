import { describe, expect, it } from 'vitest';
import {
  messageCreateRequestSchema,
  messagePageQuerySchema,
  ticketCreateRequestSchema,
  ticketListQuerySchema,
  ticketUpdateRequestSchema,
} from './ticket.js';

const UUID = '01937f5e-7e53-7000-8000-000000000011';

describe('ticketListQuerySchema', () => {
  it('defaults to the desk’s own ordering and page size', () => {
    expect(ticketListQuerySchema.parse({})).toMatchObject({
      sort: 'updatedAt',
      direction: 'desc',
      limit: 25,
    });
  });

  it('reads a single chip as a one-element list, which is what a browser sends', () => {
    expect(ticketListQuerySchema.parse({ statusId: UUID }).statusId).toEqual([UUID]);
  });

  it('reads several chips as the list they are', () => {
    expect(ticketListQuerySchema.parse({ priority: ['high', 'urgent'] }).priority).toEqual([
      'high',
      'urgent',
    ]);
  });

  it('accepts the unassigned chip beside real people', () => {
    expect(ticketListQuerySchema.parse({ assigneeId: [UUID, 'unassigned'] }).assigneeId).toEqual([
      UUID,
      'unassigned',
    ]);
  });

  it('refuses an assignee that is neither a uuid nor the chip', () => {
    expect(ticketListQuerySchema.safeParse({ assigneeId: ['nobody'] }).success).toBe(false);
  });

  it('coerces the limit a query string carries as text', () => {
    expect(ticketListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps the page size, so one request cannot ask for the whole brand', () => {
    expect(ticketListQuerySchema.safeParse({ limit: 5000 }).success).toBe(false);
  });

  it('caps how many chips one filter may carry', () => {
    const many = Array.from({ length: 51 }, () => UUID);

    expect(ticketListQuerySchema.safeParse({ statusId: many }).success).toBe(false);
  });

  it('trims a search term, so a field of spaces is not a search', () => {
    expect(ticketListQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('bounds the search term', () => {
    expect(ticketListQuerySchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });

  it('refuses a sort it does not have an index for', () => {
    expect(ticketListQuerySchema.safeParse({ sort: 'subject' }).success).toBe(false);
  });
});

describe('ticketCreateRequestSchema', () => {
  const valid = { subject: 'Refund request', bodyHtml: '<p>hi</p>', departmentId: UUID };

  it('defaults a manual ticket to the manual channel', () => {
    expect(ticketCreateRequestSchema.parse(valid)).toMatchObject({ channel: 'manual' });
  });

  /**
   * M1-06 took the schema default off `priority`, because a template supplies
   * one and a default here would overwrite it with `medium` on every request
   * that did not name a priority. The api applies the same fallback once the
   * template has had its say.
   */
  it('leaves an unnamed priority for the api to settle with the template', () => {
    expect(ticketCreateRequestSchema.parse(valid).priority).toBeUndefined();
  });

  it('trims the subject, so a field of spaces is not a subject', () => {
    expect(ticketCreateRequestSchema.safeParse({ ...valid, subject: '   ' }).success).toBe(false);
  });

  it('requires a body, because a ticket with no message is one nobody can answer', () => {
    expect(ticketCreateRequestSchema.safeParse({ ...valid, bodyHtml: '' }).success).toBe(false);
  });

  it('requires a department, because a ticket without one is invisible to everyone', () => {
    expect(
      ticketCreateRequestSchema.safeParse({ subject: 'x', bodyHtml: '<p>x</p>' }).success,
    ).toBe(false);
  });

  it('bounds the subject at a full email Subject: line', () => {
    expect(
      ticketCreateRequestSchema.safeParse({ ...valid, subject: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});

describe('ticketUpdateRequestSchema', () => {
  it('lets a field be cleared by naming it null', () => {
    expect(ticketUpdateRequestSchema.parse({ assigneeId: null }).assigneeId).toBeNull();
  });

  it('accepts an empty body, which the handler refuses with a sentence', () => {
    // A schema cannot say "at least one of these"; the handler answers 400 so
    // that "nothing changed" never looks like "it worked".
    expect(ticketUpdateRequestSchema.parse({})).toEqual({});
  });

  it('refuses a subject of spaces', () => {
    expect(ticketUpdateRequestSchema.safeParse({ subject: '  ' }).success).toBe(false);
  });
});

describe('messageCreateRequestSchema', () => {
  it('requires the kind rather than defaulting it', () => {
    // A note posted as a public reply by an omitted default is the worst bug
    // this endpoint could have.
    expect(messageCreateRequestSchema.safeParse({ bodyHtml: '<p>x</p>' }).success).toBe(false);
  });

  it('allows only public and note; system and ai are the server’s to write', () => {
    expect(
      messageCreateRequestSchema.safeParse({ kind: 'system', bodyHtml: '<p>x</p>' }).success,
    ).toBe(false);
  });

  it('takes the client id that dedupes a retry', () => {
    expect(
      messageCreateRequestSchema.parse({ kind: 'note', bodyHtml: '<p>x</p>', clientId: UUID })
        .clientId,
    ).toBe(UUID);
  });
});

describe('messagePageQuerySchema', () => {
  it('starts at the beginning of the thread', () => {
    expect(messagePageQuerySchema.parse({})).toEqual({ after: 0, limit: 25 });
  });

  it('coerces the cursor a query string carries as text', () => {
    expect(messagePageQuerySchema.parse({ after: '12' }).after).toBe(12);
  });

  it('refuses a negative cursor', () => {
    expect(messagePageQuerySchema.safeParse({ after: -1 }).success).toBe(false);
  });
});

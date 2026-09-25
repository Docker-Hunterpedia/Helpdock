import type { RelatedTicket, Ticket } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { linkReferences, mergeCandidates, unmergeHoursLeft, visibleLinks } from './merge.js';
import { MOCK_STATUS_CLOSED, MockTicketsApi } from './mock-api.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (offset: number): string => new Date(NOW + offset).toISOString();

describe('unmergeHoursLeft', () => {
  it('rounds up, so a fresh merge reads 24 h and the last hour reads 1 h', () => {
    expect(unmergeHoursLeft(at(24 * HOUR - 60_000), NOW)).toBe(24);
    expect(unmergeHoursLeft(at(23 * HOUR), NOW)).toBe(23);
    expect(unmergeHoursLeft(at(60_000), NOW)).toBe(1);
  });

  it('is null once the window has closed, or when there is none', () => {
    expect(unmergeHoursLeft(at(0), NOW)).toBeNull();
    expect(unmergeHoursLeft(at(-HOUR), NOW)).toBeNull();
    expect(unmergeHoursLeft(null, NOW)).toBeNull();
  });
});

describe('mergeCandidates', () => {
  const ticket = (id: string, mergedIntoId: string | null = null) =>
    ({ id, mergedIntoId }) as Ticket;

  it('leaves out the ticket being merged and any ticket already merged', () => {
    const rows = [ticket('self'), ticket('open'), ticket('gone', 'elsewhere')];

    expect(mergeCandidates(rows, 'self').map((row) => row.id)).toEqual(['open']);
  });
});

describe('linkReferences', () => {
  const split = { id: 't-1043', number: 1043, prefix: 'HD', subject: 'VAT' };

  it('links a reference the reader can open', () => {
    expect(linkReferences('Messages split to HD-1043', [split])).toEqual([
      { kind: 'text', text: 'Messages split to ' },
      { kind: 'link', text: 'HD-1043', ticketId: 't-1043' },
    ]);
  });

  it('links it wherever the sentence puts it, as Arabic word order does', () => {
    expect(linkReferences('مفصولة من HD-1043 اليوم', [split])).toEqual([
      { kind: 'text', text: 'مفصولة من ' },
      { kind: 'link', text: 'HD-1043', ticketId: 't-1043' },
      { kind: 'text', text: ' اليوم' },
    ]);
  });

  it('matches a reference whole, never inside a longer one', () => {
    const short = { ...split, id: 't-104', number: 104 };

    expect(linkReferences('Messages split to HD-1043', [short])).toEqual([
      { kind: 'text', text: 'Messages split to HD-1043' },
    ]);
  });

  it('leaves the sentence alone when there is nothing to link', () => {
    expect(linkReferences('Continued in HD-1101', [])).toEqual([
      { kind: 'text', text: 'Continued in HD-1101' },
    ]);
  });
});

describe('visibleLinks', () => {
  it('keeps the linked tickets the reader can open and drops the hidden ones', async () => {
    const { statuses } = await new MockTicketsApi().statuses('brand');
    const status = statuses.find((row) => row.id === MOCK_STATUS_CLOSED);
    if (status === undefined) {
      throw new Error('the fixture seeds a Closed status');
    }
    const shown: RelatedTicket = {
      visible: true,
      relation: 'splitTo',
      id: 't-1043',
      number: 1043,
      prefix: 'HD',
      subject: 'VAT',
      status,
    };

    expect(visibleLinks([{ visible: false, relation: 'parent' }, shown])).toEqual([shown]);
  });
});

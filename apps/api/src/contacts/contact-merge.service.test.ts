import type {
  ContactDuplicateSuggestion,
  ContactMerge,
  Contact as ContactRow,
  DbTransaction,
} from '@helpdock/db';
import type { ContactDetail } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContactMergeService } from './contact-merge.service.js';
import type { ContactMergesRepository } from './contact-merges.repository.js';
import type { ContactsRepository } from './contacts.repository.js';
import type { ContactContext } from './contacts.service.js';

/**
 * The merge rules against repositories that remember, not a database. The
 * database half — that every ticket really moves, hidden ones included, and
 * that an undo moves exactly those back — is `contact-identity.integration.test.ts`.
 * This proves the decisions: which refusal, in what order, and what the merge
 * record and the audit row say.
 */

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const ACTOR = '01937f5e-7e53-7000-8000-000000000001';
const SURVIVOR = '01937f5e-7e53-7000-8000-0000000000c1';
const MERGED = '01937f5e-7e53-7000-8000-0000000000c2';
const SUGGESTION = '01937f5e-7e53-7000-8000-0000000000d1';
const MERGE = '01937f5e-7e53-7000-8000-0000000000e1';

const contact = (id: string, overrides: Partial<ContactRow> = {}): ContactRow => ({
  id,
  brandId: BRAND,
  accountId: null,
  name: id === SURVIVOR ? 'Mona Khalil' : 'Mona K.',
  locale: null,
  timezone: null,
  externalId: null,
  custom: {},
  notesCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  anonymisedAt: null,
  mergedIntoId: null,
  mergedAt: null,
  ...overrides,
});

const mergeRow = (overrides: Partial<ContactMerge> = {}): ContactMerge => ({
  id: MERGE,
  brandId: BRAND,
  survivorId: SURVIVOR,
  mergedId: MERGED,
  suggestionId: null,
  actorId: ACTOR,
  movedIdentityIds: ['i1'],
  movedTicketIds: ['t1', 't2'],
  movedNoteIds: [],
  createdAt: new Date(),
  undoUntil: new Date(Date.now() + 60_000),
  undoneAt: null,
  undoneBy: null,
  ...overrides,
});

let rows: Map<string, ContactRow>;
let merges: ContactMerge[];
let suggestionStatus: string[];
let audit: { action: string; meta: Record<string, unknown> }[];
let calls: string[];
let suggestion: ContactDuplicateSuggestion | undefined;

const mergesRepository = {
  lockPair: async (_tx: DbTransaction, ids: readonly string[]) =>
    ids.flatMap((id) => {
      const row = rows.get(id);
      return row === undefined ? [] : [row];
    }),
  ticketCount: async () => 3,
  moveIdentities: async (_tx: DbTransaction, { ids }: { ids?: string[] }) => {
    calls.push('identities');
    return ids ?? ['i1'];
  },
  moveNotes: async () => {
    calls.push('notes');
    return [];
  },
  moveTickets: async (_tx: DbTransaction, { ids }: { ids?: readonly string[] }) => {
    calls.push('tickets');
    return [...(ids ?? ['t1', 't2'])];
  },
  markMerged: async (_tx: DbTransaction, id: string, into: string | null) => {
    const row = rows.get(id);
    if (row !== undefined) {
      rows.set(id, { ...row, mergedIntoId: into });
    }
  },
  openSuggestionFor: async () => suggestion?.id,
  setPairSuggestions: async (_tx: DbTransaction, { to }: { to: string }) => {
    suggestionStatus.push(to);
  },
  insert: async (_tx: DbTransaction, values: Partial<ContactMerge>) => {
    const row = mergeRow(values);
    merges.push(row);
    return row;
  },
  find: async (_tx: DbTransaction, survivorId: string, mergeId: string) =>
    merges.find((row) => row.id === mergeId && row.survivorId === survivorId),
  markUndone: async (_tx: DbTransaction, mergeId: string) => {
    calls.push(`undone:${mergeId}`);
  },
  activeInto: async () => [],
} as unknown as ContactMergesRepository;

const contactsRepository = {
  find: async (_tx: DbTransaction, id: string) => rows.get(id),
  identitiesOf: async () => [],
  account: async () => undefined,
  duplicate: async () => suggestion,
} as unknown as ContactsRepository;

const tx = {
  insert: () => ({
    values: (row: { action: string; meta: Record<string, unknown> }) => {
      audit.push(row);
      return Promise.resolve();
    },
  }),
} as unknown as DbTransaction;

const context: ContactContext = { tx, brandId: BRAND, actor: { userId: ACTOR, role: 'agent' } };

const service = new ContactMergeService({
  merges: mergesRepository,
  contacts: contactsRepository,
  detail: { detail: async (_context, id) => ({ id }) as unknown as ContactDetail },
});

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof NotFoundException ? 'not-found' : (error as { reason?: string }).reason,
  );

beforeEach(() => {
  rows = new Map([
    [SURVIVOR, contact(SURVIVOR)],
    [MERGED, contact(MERGED)],
  ]);
  merges = [];
  suggestionStatus = [];
  audit = [];
  calls = [];
  suggestion = undefined;
});

describe('merge', () => {
  it('moves identifiers, notes and tickets, then records the merge and an audit row', async () => {
    const result = await service.merge(context, SURVIVOR, { mergedContactId: MERGED });

    expect(result.id).toBe(SURVIVOR);
    expect(calls).toEqual(['identities', 'notes', 'tickets']);
    expect(rows.get(MERGED)?.mergedIntoId).toBe(SURVIVOR);
    expect(suggestionStatus).toEqual(['merged']);
    expect(merges[0]).toMatchObject({ movedTicketIds: ['t1', 't2'], actorId: ACTOR });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'contact.merged',
        meta: expect.objectContaining({ mergedContactId: MERGED, ticketCount: 2 }),
      }),
    ]);
  });

  it('records the open suggestion of the pair when none was named', async () => {
    suggestion = { id: SUGGESTION } as ContactDuplicateSuggestion;

    await service.merge(context, SURVIVOR, { mergedContactId: MERGED });

    expect(merges[0]?.suggestionId).toBe(SUGGESTION);
  });

  it('refuses a contact merged into itself before touching anything', async () => {
    expect(await reasonOf(service.merge(context, SURVIVOR, { mergedContactId: SURVIVOR }))).toBe(
      'merge-self',
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ['an erased contact', { anonymisedAt: new Date() }, 'anonymised'],
    ['a contact already merged elsewhere', { mergedIntoId: SURVIVOR }, 'merged'],
  ])('refuses %s', async (_label, overrides, reason) => {
    rows.set(MERGED, contact(MERGED, overrides));

    expect(await reasonOf(service.merge(context, SURVIVOR, { mergedContactId: MERGED }))).toBe(
      reason,
    );
    expect(calls).toEqual([]);
  });

  it('answers 404 for a contact that is not there', async () => {
    rows.delete(MERGED);

    expect(await reasonOf(service.merge(context, SURVIVOR, { mergedContactId: MERGED }))).toBe(
      'not-found',
    );
  });

  it('answers 404 for a suggestion about some other pair', async () => {
    suggestion = {
      id: SUGGESTION,
      contactId: SURVIVOR,
      otherContactId: '01937f5e-7e53-7000-8000-0000000000c9',
    } as ContactDuplicateSuggestion;

    expect(
      await reasonOf(
        service.merge(context, SURVIVOR, { mergedContactId: MERGED, suggestionId: SUGGESTION }),
      ),
    ).toBe('not-found');
  });
});

describe('undo', () => {
  beforeEach(() => {
    rows.set(MERGED, contact(MERGED, { mergedIntoId: SURVIVOR }));
    merges = [mergeRow()];
  });

  it('moves back exactly what the merge moved, and reopens the suggestion', async () => {
    await service.undo(context, SURVIVOR, MERGE);

    expect(calls).toEqual(['identities', 'notes', 'tickets', `undone:${MERGE}`]);
    expect(rows.get(MERGED)?.mergedIntoId).toBeNull();
    expect(suggestionStatus).toEqual(['open']);
    expect(audit[0]).toMatchObject({
      action: 'contact.merge.undone',
      meta: { identityCount: 1, ticketCount: 2 },
    });
  });

  it('refuses once the 24 hours are up, and a second undo', async () => {
    merges = [mergeRow({ undoUntil: new Date(Date.now() - 1) })];
    expect(await reasonOf(service.undo(context, SURVIVOR, MERGE))).toBe('merge-expired');

    merges = [mergeRow({ undoneAt: new Date() })];
    expect(await reasonOf(service.undo(context, SURVIVOR, MERGE))).toBe('merge-expired');
  });

  it.each([
    ['the survivor was merged onwards', SURVIVOR, { mergedIntoId: MERGED }],
    ['the survivor was erased', SURVIVOR, { anonymisedAt: new Date() }],
    ['the merged contact was erased', MERGED, { anonymisedAt: new Date(), mergedIntoId: SURVIVOR }],
  ])('refuses when %s', async (_label, id, overrides) => {
    rows.set(id, contact(id, overrides));

    expect(await reasonOf(service.undo(context, SURVIVOR, MERGE))).toBe('merge-blocked');
    expect(calls).toEqual([]);
  });

  it('answers 404 for a merge into some other contact', async () => {
    expect(await reasonOf(service.undo(context, MERGED, MERGE))).toBe('not-found');
  });
});

describe('preview', () => {
  it('counts every ticket of both sides and refuses a contact against itself', async () => {
    const preview = await service.preview(context, SURVIVOR, MERGED);

    expect(preview.contact).toMatchObject({ id: SURVIVOR, ticketCount: 3, accountName: null });
    expect(preview.other).toMatchObject({ id: MERGED, name: 'Mona K.' });
    expect(await reasonOf(service.preview(context, SURVIVOR, SURVIVOR))).toBe('merge-self');
  });
});

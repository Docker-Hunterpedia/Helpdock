import type { DbTransaction, NewTag, Tag as TagRow } from '@helpdock/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { contextFor, type FakeTransaction, fakeTransaction } from './service-fakes.js';
import type { TagsRepository, TagWithCount } from './tags.repository.js';
import { TagsService } from './tags.service.js';

/**
 * The tag rules, against a repository that remembers rather than a database.
 * What the database proves is in `ticketing.integration.test.ts`; what this
 * proves is the decisions — which refusal, which audit verb, what a reorder
 * accepts — without a container between the rule and the assertion.
 */

let rows: TagWithCount[];
let deleted: string[];
let ordered: readonly string[];

const tag = (id: string, name: string, sortOrder: number, ticketCount = 0): TagWithCount => ({
  tag: {
    id,
    brandId: '01937f5e-7e53-7000-8000-0000000000b1',
    name,
    nameAr: null,
    color: 'sand',
    sortOrder,
    createdAt: new Date(),
  },
  ticketCount,
});

const repository = {
  list: async () => rows,
  find: async (_tx: DbTransaction, id: string) => rows.find((row) => row.tag.id === id)?.tag,
  existing: async (_tx: DbTransaction, ids: readonly string[]) =>
    new Set(ids.filter((id) => rows.some((row) => row.tag.id === id))),
  nameTaken: async (
    _tx: DbTransaction,
    name: string,
    { exceptId }: { readonly exceptId?: string } = {},
  ) =>
    rows.some(
      (row) => row.tag.name.toLowerCase() === name.toLowerCase() && row.tag.id !== exceptId,
    ),
  ticketCount: async (_tx: DbTransaction, id: string) =>
    rows.find((row) => row.tag.id === id)?.ticketCount ?? 0,
  nextSortOrder: async () => rows.length,
  create: async (_tx: DbTransaction, values: NewTag) => {
    const created: TagRow = {
      id: 'created',
      brandId: values.brandId,
      name: values.name,
      nameAr: values.nameAr ?? null,
      color: values.color ?? 'sand',
      sortOrder: values.sortOrder ?? 0,
      createdAt: new Date(),
    };
    rows.push({ tag: created, ticketCount: 0 });

    return created;
  },
  // A new row rather than a mutation of the stored one, because that is what
  // `UPDATE … RETURNING` hands back — and a service that read the old values
  // out of a mutated object would pass here and fail in production.
  update: async (_tx: DbTransaction, id: string, values: Partial<NewTag>) => {
    const row = rows.find((candidate) => candidate.tag.id === id);
    if (row === undefined) {
      return undefined;
    }
    const updated = { ...row.tag, ...values } as TagRow;
    rows = rows.map((candidate) =>
      candidate.tag.id === id ? { ...candidate, tag: updated } : candidate,
    );

    return updated;
  },
  delete: async (_tx: DbTransaction, id: string) => {
    deleted.push(id);
    rows = rows.filter((row) => row.tag.id !== id);
  },
  reorder: async (_tx: DbTransaction, ids: readonly string[]) => {
    ordered = ids;
  },
} satisfies Partial<TagsRepository> as unknown as TagsRepository;

let service: TagsService;
let transaction: FakeTransaction;

beforeEach(() => {
  rows = [];
  deleted = [];
  ordered = [];
  rows.push(tag('a', 'Refund', 0, 12), tag('b', 'VIP', 1));
  service = new TagsService(repository);
  transaction = fakeTransaction();
});

describe('list', () => {
  it('answers the brand’s tags with their counts', async () => {
    await expect(service.list(transaction.tx)).resolves.toEqual({
      tags: [
        { id: 'a', name: 'Refund', nameAr: null, color: 'sand', sortOrder: 0, ticketCount: 12 },
        { id: 'b', name: 'VIP', nameAr: null, color: 'sand', sortOrder: 1, ticketCount: 0 },
      ],
    });
  });
});

describe('usage', () => {
  it('answers the count the confirmation reads', async () => {
    await expect(service.usage(transaction.tx, 'a')).resolves.toEqual({
      tagId: 'a',
      ticketCount: 12,
    });
  });

  it('is a 404 for a tag this brand does not have', async () => {
    await expect(service.usage(transaction.tx, 'missing')).rejects.toThrow(/no such tag/i);
  });
});

describe('create', () => {
  it('writes the tag and an audit row naming it', async () => {
    const created = await service.create(contextFor(transaction.tx), {
      name: 'Chargeback',
      color: 'info',
    });

    expect(created).toMatchObject({ name: 'Chargeback', color: 'info', ticketCount: 0 });
    expect(transaction.audit).toHaveLength(1);
    expect(transaction.audit[0]).toMatchObject({
      action: 'tag.created',
      targetType: 'tag',
      meta: { name: 'Chargeback', color: 'info' },
    });
  });

  it('refuses a name another tag already has, whatever its case', async () => {
    await expect(
      service.create(contextFor(transaction.tx), { name: 'refund', color: 'info' }),
    ).rejects.toThrow(TicketingFailure);
    expect(transaction.audit).toEqual([]);
  });
});

describe('update', () => {
  it('records what moved, and what it moved from', async () => {
    await service.update(contextFor(transaction.tx), 'a', { name: 'Refunds', color: 'success' });

    expect(transaction.audit[0]).toMatchObject({
      action: 'tag.updated',
      meta: { name: 'Refunds', wasNamed: 'Refund', color: 'success', wasColored: 'sand' },
    });
  });

  it('says nothing about a field the request did not name', async () => {
    await service.update(contextFor(transaction.tx), 'a', { color: 'warning' });

    expect(transaction.audit[0]?.meta).toEqual({ color: 'warning', wasColored: 'sand' });
  });

  it('lets a tag keep its own name, in a different case', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'a', { name: 'REFUND' }),
    ).resolves.toMatchObject({ name: 'REFUND' });
  });

  it('refuses a name another tag already has', async () => {
    await expect(service.update(contextFor(transaction.tx), 'a', { name: 'VIP' })).rejects.toThrow(
      TicketingFailure,
    );
  });

  it('is a 404 for a tag this brand does not have', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'missing', { color: 'info' }),
    ).rejects.toThrow(/no such tag/i);
  });
});

describe('remove', () => {
  it('deletes it and records how much it was taken off', async () => {
    await service.remove(contextFor(transaction.tx), 'a');

    expect(deleted).toEqual(['a']);
    expect(transaction.audit[0]).toMatchObject({
      action: 'tag.deleted',
      meta: { name: 'Refund', detachedFrom: 12 },
    });
  });
});

describe('reorder', () => {
  it('sends the whole list and records the order', async () => {
    await service.reorder(contextFor(transaction.tx), { tagIds: ['b', 'a'] });

    expect(ordered).toEqual(['b', 'a']);
    expect(transaction.audit[0]).toMatchObject({
      action: 'tag.reordered',
      targetType: 'brand',
      meta: { order: ['b', 'a'] },
    });
  });

  it('refuses an order that names a tag twice', async () => {
    await expect(
      service.reorder(contextFor(transaction.tx), { tagIds: ['a', 'a'] }),
    ).rejects.toThrow(/names a tag twice/i);
  });

  it('refuses a partial order rather than half-applying it', async () => {
    await expect(service.reorder(contextFor(transaction.tx), { tagIds: ['a'] })).rejects.toThrow(
      /exactly once/i,
    );
    expect(ordered).toEqual([]);
  });

  it('refuses an order naming a tag the brand does not have', async () => {
    await expect(
      service.reorder(contextFor(transaction.tx), { tagIds: ['a', 'elsewhere'] }),
    ).rejects.toThrow(/exactly once/i);
  });
});

describe('unknownIds', () => {
  it('names the ids this brand does not have, once each', async () => {
    await expect(service.unknownIds(transaction.tx, ['a', 'x', 'x'])).resolves.toEqual(['x']);
  });

  it('answers nothing for an empty list, without asking the database', async () => {
    await expect(service.unknownIds(transaction.tx, [])).resolves.toEqual([]);
  });
});

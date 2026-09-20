import type { CustomFieldDefRow, DbTransaction, NewCustomFieldDef } from '@helpdock/db';
import type { CustomFieldTarget } from '@helpdock/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import type { CustomFieldsRepository, FieldUsage } from './custom-fields.repository.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { ADMIN, contextFor, type FakeTransaction, fakeTransaction } from './service-fakes.js';

/**
 * The custom field rules, against a repository that remembers.
 *
 * Three of them only exist because values are already stored — a key that
 * cannot move, a type that cannot move, an option that cannot be dropped — and
 * each of the three has a branch here for the case that makes it fire and for
 * the case that does not.
 */

let rows: CustomFieldDefRow[];
let usage: Record<string, FieldUsage>;
let cleared: { key: string; option: string }[];
let ordered: readonly string[];

const def = (over: Partial<CustomFieldDefRow> & { id: string }): CustomFieldDefRow => ({
  brandId: '01937f5e-7e53-7000-8000-0000000000b1',
  target: 'ticket',
  key: 'tier',
  label: 'Plan tier',
  labelAr: null,
  type: 'text',
  options: [],
  required: false,
  agentVisible: true,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const repository = {
  list: async (_tx: DbTransaction, target?: CustomFieldTarget) =>
    rows.filter((row) => target === undefined || row.target === target),
  find: async (_tx: DbTransaction, id: string) => rows.find((row) => row.id === id),
  keyTaken: async (_tx: DbTransaction, target: CustomFieldTarget, key: string) =>
    rows.some((row) => row.target === target && row.key === key),
  nextSortOrder: async (_tx: DbTransaction, target: CustomFieldTarget) =>
    rows.filter((row) => row.target === target).length,
  create: async (_tx: DbTransaction, values: NewCustomFieldDef) => {
    const created = def({ ...values, id: 'created' } as Partial<CustomFieldDefRow> & {
      id: string;
    });
    rows.push(created);

    return created;
  },
  update: async (_tx: DbTransaction, id: string, values: Partial<NewCustomFieldDef>) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return undefined;
    }
    const updated = { ...row, ...values } as CustomFieldDefRow;
    rows = rows.map((candidate) => (candidate.id === id ? updated : candidate));

    return updated;
  },
  delete: async (_tx: DbTransaction, id: string) => {
    rows = rows.filter((row) => row.id !== id);
  },
  reorder: async (_tx: DbTransaction, ids: readonly string[]) => {
    ordered = ids;
  },
  usage: async (_tx: DbTransaction, field: CustomFieldDefRow) =>
    usage[field.key] ?? { rows: 0, optionRows: {} },
  clearOption: async (_tx: DbTransaction, field: CustomFieldDefRow, option: string) => {
    cleared.push({ key: field.key, option });
  },
} satisfies Partial<CustomFieldsRepository> as unknown as CustomFieldsRepository;

let service: CustomFieldsService;
let transaction: FakeTransaction;

beforeEach(() => {
  rows = [
    def({ id: 'tier', key: 'tier', type: 'select', options: ['gold', 'silver', 'bronze'] }),
    def({ id: 'seats', key: 'seats', type: 'number', target: 'contact', label: 'Seats' }),
  ];
  usage = { tier: { rows: 7, optionRows: { gold: 4 } } };
  cleared = [];
  ordered = [];
  service = new CustomFieldsService(repository);
  transaction = fakeTransaction();
});

describe('list', () => {
  it('answers every target at once when none is named', async () => {
    const { fields } = await service.list(transaction.tx);

    expect(fields.map((field) => field.key)).toEqual(['tier', 'seats']);
  });

  it('narrows to one target when one is', async () => {
    const { fields } = await service.list(transaction.tx, 'contact');

    expect(fields.map((field) => field.key)).toEqual(['seats']);
  });
});

describe('usage', () => {
  it('answers the rows and the rows per option', async () => {
    await expect(service.usage(transaction.tx, 'tier')).resolves.toEqual({
      fieldId: 'tier',
      rows: 7,
      optionRows: { gold: 4 },
    });
  });

  it('is a 404 for a field this brand does not have', async () => {
    await expect(service.usage(transaction.tx, 'missing')).rejects.toThrow(/no such custom field/i);
  });
});

describe('create', () => {
  it('writes the definition and an audit row naming its key', async () => {
    await service.create(contextFor(transaction.tx), {
      target: 'ticket',
      key: 'renews_on',
      label: 'Renews on',
      type: 'date',
      options: [],
      required: false,
      agentVisible: true,
    });

    expect(transaction.audit[0]).toMatchObject({
      action: 'custom_field.created',
      meta: { target: 'ticket', key: 'renews_on', type: 'date' },
    });
  });

  it('refuses a key the target already has', async () => {
    await expect(
      service.create(contextFor(transaction.tx), {
        target: 'ticket',
        key: 'tier',
        label: 'Another tier',
        type: 'text',
        options: [],
        required: false,
        agentVisible: true,
      }),
    ).rejects.toThrow(TicketingFailure);
  });

  it('lets the same key exist on another target, because the lists are separate', async () => {
    await expect(
      service.create(contextFor(transaction.tx), {
        target: 'account',
        key: 'tier',
        label: 'Account tier',
        type: 'text',
        options: [],
        required: false,
        agentVisible: true,
      }),
    ).resolves.toMatchObject({ key: 'tier' });
  });
});

describe('update', () => {
  it('renames without touching anything stored', async () => {
    await service.update(contextFor(transaction.tx), 'tier', { label: 'Tier', force: false });

    expect(transaction.audit[0]).toMatchObject({
      action: 'custom_field.updated',
      meta: { key: 'tier', label: 'Tier', wasLabelled: 'Plan tier' },
    });
  });

  it('refuses a type change while rows carry a value', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'tier', { type: 'text', force: false }),
    ).rejects.toThrow(TicketingFailure);
  });

  it('allows a type change when nothing carries a value', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'seats', { type: 'text', force: false }),
    ).resolves.toMatchObject({ type: 'text' });
  });

  it('refuses a type change to somebody who cannot see every department', async () => {
    const scoped = contextFor(transaction.tx, { ...ADMIN, role: 'team_leader', departmentIds: [] });

    // A count is of rows the actor can see; acting on a partial one would leave
    // rows nobody warned them about.
    await expect(service.update(scoped, 'seats', { type: 'text', force: false })).rejects.toThrow(
      TicketingFailure,
    );
  });

  it('refuses removing an option rows still carry', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'tier', {
        options: ['silver', 'bronze'],
        force: false,
      }),
    ).rejects.toThrow(TicketingFailure);
    expect(cleared).toEqual([]);
  });

  it('removes an option nothing carries without asking', async () => {
    await service.update(contextFor(transaction.tx), 'tier', {
      options: ['gold', 'silver'],
      force: false,
    });

    expect(cleared).toEqual([]);
    expect(transaction.audit[0]?.meta).toMatchObject({
      options: ['gold', 'silver'],
      wasOptioned: ['gold', 'silver', 'bronze'],
    });
  });

  it('clears an option in use when the request carries force', async () => {
    await service.update(contextFor(transaction.tx), 'tier', {
      options: ['silver', 'bronze'],
      force: true,
    });

    expect(cleared).toEqual([{ key: 'tier', option: 'gold' }]);
  });

  it('refuses to leave a choice type with no options at all', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'tier', { options: [], force: true }),
    ).rejects.toThrow(/at least one option/i);
  });

  it('refuses options on a type that has no choices', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'seats', { options: ['x'], force: false }),
    ).rejects.toThrow(/only select fields/i);
  });

  it('is a 404 for a field this brand does not have', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'missing', { label: 'x', force: false }),
    ).rejects.toThrow(/no such custom field/i);
  });
});

describe('remove', () => {
  it('deletes the definition and records how much it hid', async () => {
    await service.remove(contextFor(transaction.tx), 'tier');

    expect(rows.map((row) => row.id)).toEqual(['seats']);
    expect(transaction.audit[0]).toMatchObject({
      action: 'custom_field.deleted',
      meta: { target: 'ticket', key: 'tier', hiddenOn: 7 },
    });
  });
});

describe('reorder', () => {
  it('records one target’s order', async () => {
    await service.reorder(contextFor(transaction.tx), { target: 'ticket', fieldIds: ['tier'] });

    expect(ordered).toEqual(['tier']);
    expect(transaction.audit[0]).toMatchObject({
      action: 'custom_field.reordered',
      meta: { target: 'ticket', order: ['tier'] },
    });
  });

  it('refuses an order that names a field twice', async () => {
    await expect(
      service.reorder(contextFor(transaction.tx), { target: 'ticket', fieldIds: ['tier', 'tier'] }),
    ).rejects.toThrow(/names a field twice/i);
  });

  it('refuses a partial order', async () => {
    await expect(
      service.reorder(contextFor(transaction.tx), { target: 'contact', fieldIds: ['tier'] }),
    ).rejects.toThrow(/exactly once/i);
  });
});

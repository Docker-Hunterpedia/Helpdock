import type { CannedResponse, DbTransaction, NewCannedResponse } from '@helpdock/db';
import { MAX_MACROS_PER_BRAND, type MacroCreateRequest } from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { type FakeTransaction, fakeTransaction } from '../ticketing/service-fakes.js';
import type { MacroActor } from './macro-rules.js';
import type { MacrosRepository } from './macros.repository.js';
import { type MacrosContext, MacrosService } from './macros.service.js';

/**
 * The macro rules against a repository that remembers rather than a database.
 * What only a database proves — the owner policy, the render against a real
 * ticket, applying one with a reply — is in `macros.integration.test.ts`.
 */

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const SUPPORT = '01937f5e-7e53-7000-8000-000000000011';
const BILLING = '01937f5e-7e53-7000-8000-000000000012';
const STATUS = '01937f5e-7e53-7000-8000-0000000000c1';
const ADMIN: MacroActor = {
  userId: '01937f5e-7e53-7000-8000-000000000001',
  role: 'admin',
  departmentIds: 'all',
};
const LEADER: MacroActor = {
  userId: '01937f5e-7e53-7000-8000-000000000002',
  role: 'team_leader',
  departmentIds: [SUPPORT],
};
const AGENT: MacroActor = {
  userId: '01937f5e-7e53-7000-8000-000000000003',
  role: 'agent',
  departmentIds: [SUPPORT],
};

let rows: CannedResponse[];
let referencesExist: boolean;
let counter = 0;

const readable = (row: CannedResponse, actor: MacroActor): boolean =>
  row.ownerId === null || row.ownerId === actor.userId;

let current: MacroActor;

const repository = {
  list: async () => rows.filter((row) => readable(row, current)),
  find: async (_tx: DbTransaction, id: string) =>
    rows.filter((row) => readable(row, current)).find((row) => row.id === id),
  count: async () => rows.length,
  create: async (_tx: DbTransaction, values: NewCannedResponse) => {
    counter += 1;
    const row = {
      id: `macro-${counter}`,
      ownerId: null,
      departmentId: null,
      bodies: {},
      actions: [],
      lastUsedAt: null,
      updatedBy: null,
      createdAt: new Date('2026-09-24T10:00:00Z'),
      updatedAt: new Date('2026-09-24T10:00:00Z'),
      ...values,
    } as CannedResponse;
    rows.push(row);
    return row;
  },
  update: async (_tx: DbTransaction, id: string, values: Partial<NewCannedResponse>) => {
    const index = rows.findIndex((row) => row.id === id);
    const next = { ...rows[index], ...values } as CannedResponse;
    rows[index] = next;
    return next;
  },
  remove: async (_tx: DbTransaction, id: string) => {
    rows = rows.filter((row) => row.id !== id);
  },
  departmentExists: async (_tx: DbTransaction, id: string) => id === SUPPORT || id === BILLING,
  referencesExist: async () => referencesExist,
} as unknown as MacrosRepository;

const service = new MacrosService(repository);
let fake: FakeTransaction;

const contextFor = (actor: MacroActor): MacrosContext => {
  current = actor;
  return { tx: fake.tx, brandId: BRAND, actor };
};

const canned = (overrides: Partial<MacroCreateRequest> = {}): MacroCreateRequest => ({
  kind: 'canned',
  name: 'Shipping fees explained',
  scope: 'shared',
  departmentId: null,
  bodies: { en: 'Hi {{contact.first_name}}', ar: '' },
  actions: [],
  ...overrides,
});

beforeEach(() => {
  rows = [];
  referencesExist = true;
  fake = fakeTransaction();
});

describe('creating', () => {
  it('lets an Admin share with every department, and audits it', async () => {
    const created = await service.create(contextFor(ADMIN), canned());

    expect(created).toMatchObject({ scope: 'shared', departmentId: null, canEdit: true });
    expect(fake.audit.map((row) => row.action)).toEqual(['macro.created']);
    expect(fake.audit[0]?.meta).toMatchObject({ name: 'Shipping fees explained', kind: 'canned' });
  });

  it('keeps a personal item out of the audit log, and out of every department', async () => {
    const created = await service.create(
      contextFor(AGENT),
      canned({ scope: 'personal', departmentId: null }),
    );

    expect(created).toMatchObject({ scope: 'personal', departmentId: null, canEdit: true });
    expect(fake.audit).toEqual([]);
  });

  it('refuses an Agent a shared item, and a Team Leader one outside their departments', async () => {
    await expect(service.create(contextFor(AGENT), canned())).rejects.toBeInstanceOf(
      TicketingFailure,
    );
    await expect(
      service.create(contextFor(LEADER), canned({ departmentId: BILLING })),
    ).rejects.toMatchObject({ reason: 'out-of-scope' });

    const inSupport = await service.create(contextFor(LEADER), canned({ departmentId: SUPPORT }));
    expect(inSupport.departmentId).toBe(SUPPORT);
  });

  it('refuses a department the brand has not got', async () => {
    await expect(
      service.create(contextFor(ADMIN), canned({ departmentId: STATUS })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an action naming something the brand has not got', async () => {
    referencesExist = false;

    await expect(
      service.create(
        contextFor(ADMIN),
        canned({ kind: 'macro', actions: [{ type: 'set_status', statusId: STATUS }] }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stops at the brand’s ceiling', async () => {
    rows = Array.from({ length: MAX_MACROS_PER_BRAND }, () => ({}) as CannedResponse);

    await expect(service.create(contextFor(ADMIN), canned())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('listing', () => {
  beforeEach(async () => {
    await service.create(contextFor(ADMIN), canned({ name: 'Everyone' }));
    await service.create(contextFor(ADMIN), canned({ name: 'Billing', departmentId: BILLING }));
    await service.create(contextFor(ADMIN), canned({ name: 'Support', departmentId: SUPPORT }));
    await service.create(contextFor(AGENT), canned({ name: 'Mine', scope: 'personal' }));
  });

  it('shows an Agent what is shared with their departments and their own', async () => {
    const names = (await service.list(contextFor(AGENT), {})).macros.map((macro) => macro.name);

    expect(names.sort()).toEqual(['Everyone', 'Mine', 'Support']);
  });

  it('narrows to what a ticket of one department may use', async () => {
    const names = (await service.list(contextFor(ADMIN), { departmentId: BILLING })).macros.map(
      (macro) => macro.name,
    );

    expect(names.sort()).toEqual(['Billing', 'Everyone']);
  });

  it('says which items the reader may change', async () => {
    const macros = (await service.list(contextFor(LEADER), {})).macros;

    expect(Object.fromEntries(macros.map((macro) => [macro.name, macro.canEdit]))).toEqual({
      Everyone: false,
      Support: true,
    });
  });
});

describe('updating', () => {
  it('records only the fields that moved', async () => {
    const created = await service.create(contextFor(ADMIN), canned());
    fake.audit.length = 0;

    const updated = await service.update(contextFor(ADMIN), created.id, { name: 'Shipping fees' });

    expect(updated.name).toBe('Shipping fees');
    expect(fake.audit[0]).toMatchObject({
      action: 'macro.updated',
      meta: { before: { name: 'Shipping fees explained' }, after: { name: 'Shipping fees' } },
    });
  });

  it('moves a personal item into a department only for somebody who may edit there', async () => {
    const mine = await service.create(contextFor(AGENT), canned({ scope: 'personal' }));

    await expect(
      service.update(contextFor(AGENT), mine.id, { scope: 'shared', departmentId: SUPPORT }),
    ).rejects.toMatchObject({ reason: 'out-of-scope' });
  });

  it('refuses a shape the kind does not allow', async () => {
    const created = await service.create(contextFor(ADMIN), canned());

    await expect(
      service.update(contextFor(ADMIN), created.id, {
        actions: [{ type: 'set_priority', priority: 'high' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 404 for another department’s item, as for one that does not exist', async () => {
    const billing = await service.create(contextFor(ADMIN), canned({ departmentId: BILLING }));

    await expect(
      service.update(contextFor(LEADER), billing.id, { name: 'Taken' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('deleting', () => {
  it('audits a shared item going, with what it was', async () => {
    const created = await service.create(contextFor(ADMIN), canned());
    fake.audit.length = 0;

    await service.remove(contextFor(ADMIN), created.id);

    expect(rows).toEqual([]);
    expect(fake.audit[0]).toMatchObject({
      action: 'macro.deleted',
      meta: { before: { name: 'Shipping fees explained' } },
    });
  });

  it('refuses a Team Leader an item shared with every department', async () => {
    const created = await service.create(contextFor(ADMIN), canned());

    await expect(service.remove(contextFor(LEADER), created.id)).rejects.toBeInstanceOf(
      TicketingFailure,
    );
  });

  it('deletes a personal one without an audit row', async () => {
    const mine = await service.create(contextFor(AGENT), canned({ scope: 'personal' }));

    await service.remove(contextFor(AGENT), mine.id);

    expect(fake.audit).toEqual([]);
  });
});

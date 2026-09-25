import type { DbTransaction, NewTicketTemplate, TicketTemplate as TemplateRow } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { ADMIN, contextFor, type FakeTransaction, fakeTransaction } from './service-fakes.js';
import type { TagsService } from './tags.service.js';
import type { TemplateSubjectRow, TemplatesRepository } from './templates.repository.js';
import { TemplatesService } from './templates.service.js';

/**
 * The template rules, against a repository that remembers.
 *
 * The placeholder renderer has its own suite; what this one proves is the
 * service's share of the work — that a Team Leader stays inside the departments
 * they lead, that a deleted tag stops being a default rather than breaking the
 * template, and that applying one counts the use exactly once.
 */

const SUPPORT = '01937f5e-7e53-7000-8000-00000000d001';
const BILLING = '01937f5e-7e53-7000-8000-00000000d002';
const TAG = '01937f5e-7e53-7000-8000-00000000a001';
const GONE = '01937f5e-7e53-7000-8000-00000000a002';

let rows: TemplateRow[];
let uses: string[];
let subject: TemplateSubjectRow;

const template = (over: Partial<TemplateRow> & { id: string }): TemplateRow => ({
  brandId: '01937f5e-7e53-7000-8000-0000000000b1',
  name: 'Refund request',
  departmentId: null,
  priority: 'medium',
  subject: 'Refund for {{contact.first_name}}',
  bodyText: 'Hello {{contact.first_name}}.\n\nWe are on it.',
  defaultTagIds: [],
  customDefaults: {},
  usageCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const repository = {
  list: async () => rows,
  find: async (_tx: DbTransaction, id: string) => rows.find((row) => row.id === id),
  create: async (_tx: DbTransaction, values: NewTicketTemplate) => {
    const created = template({ ...values, id: 'created' } as Partial<TemplateRow> & { id: string });
    rows.push(created);

    return created;
  },
  update: async (_tx: DbTransaction, id: string, values: Partial<NewTicketTemplate>) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return undefined;
    }
    const updated = { ...row, ...values } as TemplateRow;
    rows = rows.map((candidate) => (candidate.id === id ? updated : candidate));

    return updated;
  },
  delete: async (_tx: DbTransaction, id: string) => {
    rows = rows.filter((row) => row.id !== id);
  },
  recordUse: async (_tx: DbTransaction, id: string) => {
    uses.push(id);
  },
  nameTaken: async (
    _tx: DbTransaction,
    name: string,
    { exceptId }: { readonly exceptId?: string } = {},
  ) => rows.some((row) => row.name.toLowerCase() === name.toLowerCase() && row.id !== exceptId),
  subject: async () => subject,
} satisfies Partial<TemplatesRepository> as unknown as TemplatesRepository;

/** Only `TAG` exists; `GONE` is the id of a tag the brand has since deleted. */
const tags = {
  unknownIds: async (_tx: DbTransaction, ids: readonly string[]) =>
    [...new Set(ids)].filter((id) => id !== TAG),
} as unknown as TagsService;

let service: TemplatesService;
let transaction: FakeTransaction;

beforeEach(() => {
  rows = [template({ id: 'refund', departmentId: BILLING, defaultTagIds: [TAG, GONE] })];
  uses = [];
  subject = { brandName: 'Helpdock', contact: { name: 'Mona Khalil', email: 'mona@example.com' } };
  service = new TemplatesService(repository, tags);
  transaction = fakeTransaction();
});

describe('list', () => {
  it('drops a default tag the brand has deleted', async () => {
    const { templates } = await service.list(transaction.tx);

    // A template is not broken by somebody tidying the tag list.
    expect(templates[0]?.defaultTagIds).toEqual([TAG]);
  });
});

describe('find', () => {
  it('is a 404 for a template this brand does not have', async () => {
    await expect(service.find(transaction.tx, 'missing')).rejects.toThrow(
      /no such ticket template/i,
    );
  });
});

describe('preview', () => {
  it('fills what the subject knows and reports what it does not', async () => {
    const preview = await service.preview(transaction.tx, 'brand', 'refund', 'contact');

    expect(preview.subject).toBe('Refund for Mona');
    expect(preview.bodyText).toBe('Hello Mona.\n\nWe are on it.');
    expect(preview.unknownPlaceholders).toEqual([]);
  });

  it('leaves the contact placeholders spelled out when no contact is named', async () => {
    subject = { brandName: 'Helpdock', contact: undefined };

    const preview = await service.preview(transaction.tx, 'brand', 'refund', undefined);

    expect(preview.subject).toBe('Refund for {{contact.first_name}}');
    expect(preview.unknownPlaceholders).toEqual(['contact.first_name']);
  });
});

describe('create', () => {
  it('writes the template and an audit row', async () => {
    await service.create(contextFor(transaction.tx), {
      name: 'Password reset',
      departmentId: SUPPORT,
      priority: 'high',
      subject: 'Reset',
      bodyText: 'Body',
      defaultTagIds: [],
      customDefaults: {},
    });

    expect(transaction.audit[0]).toMatchObject({
      action: 'ticket_template.created',
      meta: { name: 'Password reset', departmentId: SUPPORT },
    });
  });

  it('refuses a name the brand already has, whatever its case', async () => {
    await expect(
      service.create(contextFor(transaction.tx), {
        name: 'REFUND REQUEST',
        priority: 'medium',
        subject: 'Subject',
        bodyText: 'Body',
        defaultTagIds: [],
        customDefaults: {},
      }),
    ).rejects.toThrow(TicketingFailure);
  });

  it('refuses a default tag that is not this brand’s', async () => {
    await expect(
      service.create(contextFor(transaction.tx), {
        name: 'Stranger',
        priority: 'medium',
        subject: 'Subject',
        bodyText: 'Body',
        defaultTagIds: [GONE],
        customDefaults: {},
      }),
    ).rejects.toThrow(/no such tag/i);
  });

  it('refuses a department a Team Leader does not lead', async () => {
    const leader = contextFor(transaction.tx, {
      ...ADMIN,
      role: 'team_leader',
      departmentIds: [SUPPORT],
    });

    await expect(
      service.create(leader, {
        name: 'Not mine',
        departmentId: BILLING,
        priority: 'medium',
        subject: 'Subject',
        bodyText: 'Body',
        defaultTagIds: [],
        customDefaults: {},
      }),
    ).rejects.toThrow(TicketingFailure);
  });

  it('lets a Team Leader make one in a department they do lead', async () => {
    const leader = contextFor(transaction.tx, {
      ...ADMIN,
      role: 'team_leader',
      departmentIds: [SUPPORT],
    });

    await expect(
      service.create(leader, {
        name: 'Mine',
        departmentId: SUPPORT,
        priority: 'medium',
        subject: 'Subject',
        bodyText: 'Body',
        defaultTagIds: [],
        customDefaults: {},
      }),
    ).resolves.toMatchObject({ name: 'Mine' });
  });
});

describe('update', () => {
  it('refuses a Team Leader taking a template out of a department they do not lead', async () => {
    const leader = contextFor(transaction.tx, {
      ...ADMIN,
      role: 'team_leader',
      departmentIds: [SUPPORT],
    });

    // Both ends of a move are checked: `refund` is Billing's today.
    await expect(service.update(leader, 'refund', { name: 'Renamed' })).rejects.toThrow(
      TicketingFailure,
    );
  });

  it('records a department move with what it moved from', async () => {
    await service.update(contextFor(transaction.tx), 'refund', { departmentId: SUPPORT });

    expect(transaction.audit[0]).toMatchObject({
      action: 'ticket_template.updated',
      meta: { departmentId: SUPPORT, wasDepartmentId: BILLING },
    });
  });

  it('lets a template keep its own name in a different case', async () => {
    await expect(
      service.update(contextFor(transaction.tx), 'refund', { name: 'refund request' }),
    ).resolves.toMatchObject({ name: 'refund request' });
  });
});

describe('remove', () => {
  it('deletes it and records how often it had been used', async () => {
    rows = [template({ id: 'refund', usageCount: 24 })];

    await service.remove(contextFor(transaction.tx), 'refund');

    expect(rows).toEqual([]);
    expect(transaction.audit[0]).toMatchObject({
      action: 'ticket_template.deleted',
      meta: { name: 'Refund request', usageCount: 24 },
    });
  });
});

describe('apply', () => {
  it('renders the placeholders, drops a deleted default tag and counts the use', async () => {
    const row = await service.row(transaction.tx, 'refund');

    const applied = await service.apply(transaction.tx, row, {
      brandId: 'brand',
      contactId: 'contact',
      number: 'HD-1042',
    });

    expect(applied.subject).toBe('Refund for Mona');
    expect(applied.bodyText).toBe('Hello Mona.\n\nWe are on it.');
    expect(applied.departmentId).toBe(BILLING);
    expect(applied.defaultTagIds).toEqual([TAG]);
    expect(uses).toEqual(['refund']);
  });

  it('fills the ticket number, which a preview cannot', async () => {
    rows = [template({ id: 'numbered', subject: 'Re: {{ticket.number}}' })];
    const row = await service.row(transaction.tx, 'numbered');

    const applied = await service.apply(transaction.tx, row, {
      brandId: 'brand',
      number: 'HD-1042',
    });

    expect(applied.subject).toBe('Re: HD-1042');
  });

  it('counts a use once per application', async () => {
    const row = await service.row(transaction.tx, 'refund');
    const spy = vi.spyOn(repository, 'recordUse');

    await service.apply(transaction.tx, row, { brandId: 'brand', number: 'HD-1' });
    await service.apply(transaction.tx, row, { brandId: 'brand', number: 'HD-2' });

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

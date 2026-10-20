import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { allEntries, resolveEntry } from './entry-points.js';
import type { RoutingRepository } from './routing.repository.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const FIRST = '0199f4b2-0000-7000-8000-0000000000d1';
const BILLING = '0199f4b2-0000-7000-8000-0000000000d2';
const MAILBOX = '0199f4b2-0000-7000-8000-0000000000a1';
const tx = {} as DbTransaction;

const repository = (
  form: { enabled: boolean; departmentId: string | null } = { enabled: false, departmentId: null },
): RoutingRepository =>
  ({
    mailboxes: async () => [
      {
        id: MAILBOX,
        address: 'billing@helpdock.test',
        departmentId: BILLING,
        automatedAllowlist: [],
      },
    ],
    telegramBots: async () => [],
    metaAccounts: async () => [],
    webForm: async () => form,
    firstDepartmentId: async () => FIRST,
    departments: async (_tx: DbTransaction, _brand: string, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, { id, name: id, nameAr: null }])),
  }) as unknown as RoutingRepository;

describe('allEntries', () => {
  it('lists the doors in the tab’s order, with the first department standing in for the widget and a bare form', async () => {
    const entries = await allEntries(repository(), tx, BRAND);

    expect(entries.map((entry) => [entry.entry, entry.departmentId, entry.reason])).toEqual([
      ['mailbox', BILLING, 'entry_department'],
      ['widget', FIRST, 'brand_first_department'],
      ['web_form', FIRST, 'brand_first_department'],
      ['api_key', null, 'named_by_api'],
    ]);
    expect(entries.find((entry) => entry.entry === 'web_form')?.enabled).toBe(false);
  });

  it('files a form in its own department when it has one', async () => {
    const entries = await allEntries(
      repository({ enabled: true, departmentId: BILLING }),
      tx,
      BRAND,
    );

    expect(entries.find((entry) => entry.entry === 'web_form')).toMatchObject({
      enabled: true,
      departmentId: BILLING,
      reason: 'entry_department',
    });
  });
});

describe('resolveEntry', () => {
  it('finds a mailbox by id', async () => {
    const entry = await resolveEntry(repository(), tx, BRAND, {
      entry: 'mailbox',
      entryId: MAILBOX,
    });

    expect(entry).toMatchObject({ label: 'billing@helpdock.test', departmentId: BILLING });
  });

  it('refuses a door the brand does not have', async () => {
    await expect(
      resolveEntry(repository(), tx, BRAND, { entry: 'mailbox', entryId: FIRST }),
    ).rejects.toThrow('No such entry point');
  });

  it('files an API request in the department it names, and refuses one it cannot find', async () => {
    const named = await resolveEntry(repository(), tx, BRAND, {
      entry: 'api_key',
      entryId: null,
      departmentId: BILLING,
    });
    const none = {
      ...repository(),
      departments: async () => new Map(),
    } as unknown as RoutingRepository;

    expect(named.departmentId).toBe(BILLING);
    await expect(
      resolveEntry(none, tx, BRAND, { entry: 'api_key', entryId: null, departmentId: BILLING }),
    ).rejects.toThrow('No such entry point');
    await expect(
      resolveEntry(repository(), tx, BRAND, { entry: 'api_key', entryId: null }),
    ).rejects.toThrow('No such entry point');
  });
});

import type { DbTransaction, TicketTimeEntry } from '@helpdock/db';
import { type BrandSettings, defaultBrandSettings } from '@helpdock/schemas';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../auth/principal.js';
import { TicketingFailure } from '../../brands/ticketing-failure.js';
import type { TicketLifecycleRepository } from '../lifecycle/lifecycle.repository.js';
import type { TicketRepository } from '../tickets.repository.js';
import type { TimeEntriesRepository } from './time-entries.repository.js';
import { TimeEntriesService } from './time-entries.service.js';

/**
 * The rules of the Time card with the repositories stubbed: who may log, who may
 * delete what, and what the brand toggle refuses. The integration suite proves
 * the rows and the department scope.
 */

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
const DEPARTMENT = '0199f4b2-3333-7000-8000-0000000000dd';
const SAM = '0199f4b2-4444-7000-8000-000000000005';
const ADA = '0199f4b2-4444-7000-8000-000000000001';
const ENTRY = '0199f4b2-5555-7000-8000-0000000000e1';
const NOW = new Date('2026-09-20T10:00:00.000Z');

const staff = (id: string, role: 'agent' | 'team_leader'): Principal => ({
  type: 'staff',
  id,
  installAdmin: false,
  brands: { [BRAND]: { role, departmentIds: 'all' } },
});

const SAM_AGENT = staff(SAM, 'agent');
const TIA_LEADER = staff(ADA, 'team_leader');
const API_KEY: Principal = {
  type: 'apikey',
  id: 'key-1',
  brandId: BRAND,
  scopes: ['ticket:write'],
};

const entryRow = (overrides: Partial<TicketTimeEntry> = {}): TicketTimeEntry => ({
  id: ENTRY,
  brandId: BRAND,
  ticketId: TICKET,
  departmentId: DEPARTMENT,
  userId: SAM,
  messageId: null,
  seconds: 1800,
  note: null,
  createdAt: NOW,
  ...overrides,
});

interface Harness {
  readonly service: TimeEntriesService;
  readonly inserted: unknown[];
  readonly deleted: string[];
}

const harness = (
  options: {
    settings?: BrandSettings;
    ticketVisible?: boolean;
    /** Present and `undefined` means "no such entry"; absent means the default row. */
    stored?: TicketTimeEntry | undefined;
  } = {},
): Harness => {
  const settings = options.settings ?? { ...defaultBrandSettings(), timeTrackingEnabled: true };
  const ticketVisible = options.ticketVisible ?? true;
  const stored = 'stored' in options ? options.stored : entryRow();
  const inserted: unknown[] = [];
  const deleted: string[] = [];
  const entries = {
    list: () => Promise.resolve([]),
    total: () => Promise.resolve(0),
    insert: (_tx: DbTransaction, values: unknown) => {
      inserted.push(values);
      return Promise.resolve(entryRow());
    },
    find: () => Promise.resolve(stored),
    delete: (_tx: DbTransaction, id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
  } as unknown as TimeEntriesRepository;
  const tickets = {
    findTicket: () =>
      Promise.resolve(ticketVisible ? { ticket: { departmentId: DEPARTMENT } } : undefined),
  } as unknown as TicketRepository;
  const lifecycle = {
    brandSettings: () => Promise.resolve(settings),
  } as unknown as TicketLifecycleRepository;

  return { service: new TimeEntriesService(entries, tickets, lifecycle), inserted, deleted };
};

const tx = {} as DbTransaction;

describe('TimeEntriesService', () => {
  describe('create', () => {
    it('logs the entry against the caller, on the ticket’s department', async () => {
      const { service, inserted } = harness();

      await service.create(tx, BRAND, SAM_AGENT, TICKET, { seconds: 1800, note: 'Called' });

      expect(inserted).toEqual([
        {
          brandId: BRAND,
          ticketId: TICKET,
          departmentId: DEPARTMENT,
          userId: SAM,
          seconds: 1800,
          note: 'Called',
          messageId: null,
        },
      ]);
    });

    it('refuses while the brand has time tracking off', async () => {
      const { service, inserted } = harness({ settings: defaultBrandSettings() });

      await expect(service.create(tx, BRAND, SAM_AGENT, TICKET, { seconds: 60 })).rejects.toEqual(
        new TicketingFailure('time-tracking-off'),
      );
      expect(inserted).toEqual([]);
    });

    it('answers 404 for a ticket the caller cannot see', async () => {
      const { service } = harness({ ticketVisible: false });

      await expect(
        service.create(tx, BRAND, SAM_AGENT, TICKET, { seconds: 60 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an API key, which has no account to log against', async () => {
      const { service } = harness();

      await expect(
        service.create(tx, BRAND, API_KEY, TICKET, { seconds: 60 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('logWithReply', () => {
    const reply = (principal: Principal) => ({
      brandId: BRAND,
      principal,
      ticketId: TICKET,
      departmentId: DEPARTMENT,
      messageId: '0199f4b2-6666-7000-8000-0000000000f1',
      seconds: 2700,
    });

    it('logs the timer against the reply', async () => {
      const { service, inserted } = harness();

      expect(await service.logWithReply(tx, reply(SAM_AGENT))).toBe(true);
      expect(inserted).toEqual([
        expect.objectContaining({ seconds: 2700, messageId: reply(SAM_AGENT).messageId }),
      ]);
    });

    it('drops the timer, rather than refusing the reply, while tracking is off', async () => {
      const { service, inserted } = harness({ settings: defaultBrandSettings() });

      expect(await service.logWithReply(tx, reply(SAM_AGENT))).toBe(false);
      expect(inserted).toEqual([]);
    });

    it('drops the timer of a principal with no account', async () => {
      const { service } = harness();

      expect(await service.logWithReply(tx, reply(API_KEY))).toBe(false);
    });
  });

  describe('remove', () => {
    it('lets the author delete their own entry', async () => {
      const { service, deleted } = harness();

      await service.remove(tx, BRAND, SAM_AGENT, TICKET, ENTRY);

      expect(deleted).toEqual([ENTRY]);
    });

    it('refuses an Agent somebody else’s entry', async () => {
      const { service, deleted } = harness({ stored: entryRow({ userId: ADA }) });

      await expect(service.remove(tx, BRAND, SAM_AGENT, TICKET, ENTRY)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(deleted).toEqual([]);
    });

    it('lets a Team Leader delete anybody’s entry', async () => {
      const { service, deleted } = harness();

      await service.remove(tx, BRAND, TIA_LEADER, TICKET, ENTRY);

      expect(deleted).toEqual([ENTRY]);
    });

    it.each([
      ['no such entry', undefined],
      [
        'an entry of another ticket',
        entryRow({ ticketId: '0199f4b2-2222-7000-8000-0000000000bb' }),
      ],
    ])('answers 404 for %s', async (_label, stored) => {
      const { service } = harness({ stored });

      await expect(service.remove(tx, BRAND, SAM_AGENT, TICKET, ENTRY)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

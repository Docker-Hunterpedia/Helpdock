import type { DbTransaction, TicketParticipant } from '@helpdock/db';
import type { TicketCc } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal.js';
import type { ParticipantsRepository, ParticipantTicket } from './participants.repository.js';
import {
  type ParticipantContext,
  TicketParticipantsService,
} from './ticket-participants.service.js';

/**
 * The participant rules against a repository that remembers. The database half
 * — department scope, the move trigger, the merge-following read — is
 * `participants.integration.test.ts`; this proves the decisions: what counts
 * as a change, what an activity row says, and what the list leaves out.
 */

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const TICKET = '01937f5e-7e53-7000-8000-0000000000f1';
const OWN_CONTACT = '01937f5e-7e53-7000-8000-0000000000c1';
const OTHER = '01937f5e-7e53-7000-8000-0000000000c2';
const DEPARTMENT = '01937f5e-7e53-7000-8000-0000000000a1';
const STAFF = '01937f5e-7e53-7000-8000-000000000001';

let ticket: ParticipantTicket | undefined;
let ccs: TicketCc[];
let writes: { table: string; row: Record<string, unknown> }[];

const repository = {
  ticket: async () => ticket,
  contactName: async (_tx: DbTransaction, id: string) => ({ id, name: 'Mona Khalil' }),
  ccs: async () => ccs,
  staff: async () => [{ userId: STAFF, name: 'Lina' }],
  emailOf: async () => 'mona.k@acme.de',
  insert: async (
    _tx: DbTransaction,
    values: { contactId: string; address: string | null; source: TicketCc['source'] },
  ) => {
    if (ccs.some((cc) => cc.contactId === values.contactId)) {
      return undefined;
    }
    const row = { id: `p-${ccs.length}`, name: 'Someone', ...values };
    ccs.push(row);
    return row as unknown as TicketParticipant;
  },
  delete: async (_tx: DbTransaction, _ticketId: string, participantId: string) => {
    const found = ccs.find((cc) => cc.id === participantId);
    ccs = ccs.filter((cc) => cc.id !== participantId);
    return found as unknown as TicketParticipant | undefined;
  },
} as unknown as ParticipantsRepository;

/** Every `insert(...).values(...)` and `update(...)` the service makes, by table name. */
const tx = {
  insert: (table: { [key: symbol]: unknown }) => {
    const name = String(table[Symbol.for('drizzle:Name')]);
    const values = (row: Record<string, unknown>) => {
      writes.push({ table: name, row });
      const done = Promise.resolve();
      return Object.assign(done, { returning: () => Promise.resolve([{ id: 'outbox-1' }]) });
    };
    return { values };
  },
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
} as unknown as DbTransaction;

const principal: Principal = {
  type: 'staff',
  id: STAFF,
  installAdmin: false,
  brands: { [BRAND]: { role: 'agent', departmentIds: 'all' } },
} as unknown as Principal;

const context: ParticipantContext = { tx, brandId: BRAND, principal };
const service = new TicketParticipantsService(repository);

beforeEach(() => {
  ticket = { id: TICKET, departmentId: DEPARTMENT, contactId: OWN_CONTACT, assigneeId: null };
  ccs = [];
  writes = [];
});

describe('addCcParticipant', () => {
  it('copies a contact in once, with one activity row naming the contact id', async () => {
    expect(await service.addCcParticipant(context, TICKET, OTHER)).toBe(true);
    expect(await service.addCcParticipant(context, TICKET, OTHER)).toBe(false);

    expect(ccs).toMatchObject([{ contactId: OTHER, source: 'merge', address: 'mona.k@acme.de' }]);
    const activity = writes.filter((write) => write.table === 'ticket_activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]?.row).toMatchObject({
      action: 'ticket.participants.changed',
      to: { ccContactId: OTHER },
      actorType: 'staff',
    });
    expect(writes.filter((write) => write.table === 'outbox')).toHaveLength(1);
  });

  it("does nothing for the ticket's own contact, who is a participant already", async () => {
    expect(await service.addCcParticipant(context, TICKET, OWN_CONTACT)).toBe(false);
    expect(writes).toEqual([]);
  });

  it('answers 404 for a ticket this transaction cannot see', async () => {
    ticket = undefined;

    await expect(service.addCcParticipant(context, TICKET, OTHER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('removeCc', () => {
  it('takes a CC off and says so in the activity log', async () => {
    await service.addCcParticipant(context, TICKET, OTHER);
    writes = [];

    const list = await service.removeCc(context, TICKET, 'p-0');

    expect(list.ccs).toEqual([]);
    expect(writes.find((write) => write.table === 'ticket_activity')?.row).toMatchObject({
      from: { ccContactId: OTHER },
    });
  });

  it('answers 404 for a participant that is not on the ticket', async () => {
    await expect(service.removeCc(context, TICKET, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('list', () => {
  it('lists the contact, the CCs and the staff, and never the contact twice', async () => {
    ccs = [
      { id: 'p-0', contactId: OTHER, name: 'Finance', address: 'finance@acme.de', source: 'agent' },
      // A CC whose contact has since been merged into the ticket's own contact.
      { id: 'p-1', contactId: OWN_CONTACT, name: 'Mona', address: 'm@acme.de', source: 'email' },
    ];

    const list = await service.list(tx, TICKET);

    expect(list.contact).toEqual({ id: OWN_CONTACT, name: 'Mona Khalil' });
    expect(list.ccs.map((cc) => cc.id)).toEqual(['p-0']);
    expect(list.staff).toEqual([{ userId: STAFF, name: 'Lina' }]);
  });

  it('has no contact for a ticket filed without one', async () => {
    ticket = { id: TICKET, departmentId: DEPARTMENT, contactId: null, assigneeId: null };

    expect((await service.list(tx, TICKET)).contact).toBeNull();
  });
});

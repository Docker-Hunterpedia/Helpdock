import type { DbTransaction, Ticket as TicketRow } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../auth/principal.js';
import type { MergeParticipantsEvent } from '../tickets/merge/participants.hook.js';
import { ParticipantsMergeHook } from './merge-participants.hook.js';
import type { TicketParticipantsService } from './ticket-participants.service.js';

/**
 * The hook only routes: a merge copies the secondary's contact onto the
 * primary as a `merge` CC, an unmerge asks for exactly that CC back. The rules
 * are the service's (`ticket-participants.service.test.ts`); the database half
 * is `tickets/merge/merge.integration.test.ts`.
 */

const tx = {} as DbTransaction;
const principal = { type: 'staff', id: 'u-1' } as unknown as Principal;
const event: MergeParticipantsEvent = {
  brandId: 'b-1',
  primary: { id: 'primary' } as TicketRow,
  secondary: { id: 'secondary' } as TicketRow,
  contactId: 'c-2',
  principal,
  at: new Date('2026-09-24T10:00:00.000Z'),
};

const serviceWith = () => {
  const service = {
    addCcParticipant: vi.fn(async () => true),
    removeMergeCc: vi.fn(async () => true),
  };

  return {
    service,
    hook: new ParticipantsMergeHook(service as unknown as TicketParticipantsService),
  };
};

describe('ParticipantsMergeHook', () => {
  it('copies the secondary’s contact onto the primary as a merge CC', async () => {
    const { service, hook } = serviceWith();

    await hook.onContactMerged(tx, event);

    expect(service.addCcParticipant).toHaveBeenCalledWith(
      { tx, brandId: 'b-1', principal },
      'primary',
      'c-2',
      { source: 'merge' },
    );
  });

  it('asks for that CC back on an unmerge, naming the ticket that left', async () => {
    const { service, hook } = serviceWith();

    await hook.onContactUnmerged(tx, event);

    expect(service.removeMergeCc).toHaveBeenCalledWith(
      { tx, brandId: 'b-1', principal },
      'primary',
      'c-2',
      { unmergedTicketId: 'secondary' },
    );
  });
});

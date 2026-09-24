import type { DbTransaction } from '@helpdock/db';
import {
  type MergeParticipantsEvent,
  MergeParticipantsHook,
} from '../tickets/merge/participants.hook.js';
import type { TicketParticipantsService } from './ticket-participants.service.js';

/**
 * M1-13's side of M1-09's seam (DOMAIN-RULES §2.4): "if different, the
 * secondary's contact is added as a CC participant" of the primary.
 *
 * A merge copies the contact in with `source = 'merge'`; an unmerge takes off
 * that CC again, and only that one — see
 * {@link TicketParticipantsService.removeMergeCc}. Both run in the merge's own
 * transaction, so the CC and the merge commit or roll back together.
 */
export class ParticipantsMergeHook extends MergeParticipantsHook {
  readonly #participants: TicketParticipantsService;

  constructor(participants: TicketParticipantsService) {
    super();
    this.#participants = participants;
  }

  override async onContactMerged(tx: DbTransaction, event: MergeParticipantsEvent): Promise<void> {
    await this.#participants.addCcParticipant(
      { tx, brandId: event.brandId, principal: event.principal },
      event.primary.id,
      event.contactId,
      { source: 'merge' },
    );
  }

  override async onContactUnmerged(
    tx: DbTransaction,
    event: MergeParticipantsEvent,
  ): Promise<void> {
    await this.#participants.removeMergeCc(
      { tx, brandId: event.brandId, principal: event.principal },
      event.primary.id,
      event.contactId,
      { unmergedTicketId: event.secondary.id },
    );
  }
}

import type { DbTransaction, Ticket as TicketRow } from '@helpdock/db';
import { Injectable } from '@nestjs/common';

/**
 * DOMAIN-RULES §2.4: "Contact: primary's contact; if different, the
 * secondary's contact is added as a CC participant."
 *
 * Participants (§2.5) are M1-13's table and M1-13's rules, so a merge does not
 * write them. It says *that* the secondary's contact has to become one, here,
 * and M1-13 replaces this provider in `TicketsModule` with one that does it —
 * the same seam `lifecycle/hooks.ts` leaves for M3-02 and M1-12, and
 * `realtime/staff-offline.hook.ts` leaves for M1-07.
 *
 * Both methods run **inside the merge's transaction**, after both tickets have
 * moved and before the outbox rows are written, so whatever they write commits
 * or rolls back with the merge. They must not open a transaction or enqueue a
 * job directly (DOMAIN-RULES §6).
 *
 * They are called only when the two contacts differ and the secondary has one:
 * a merge of two tickets from the same person has nobody to add.
 */

export interface MergeParticipantsEvent {
  readonly brandId: string;
  readonly primary: TicketRow;
  readonly secondary: TicketRow;
  /** The secondary's contact, who joins the primary as a CC. */
  readonly contactId: string;
  readonly at: Date;
}

@Injectable()
export class MergeParticipantsHook {
  /** The secondary's contact becomes a CC participant of the primary. */
  async onContactMerged(_tx: DbTransaction, _event: MergeParticipantsEvent): Promise<void> {
    await Promise.resolve();
  }

  /**
   * The merge was undone. §2.4 does not say whether the CC stays; M1-13
   * decides, and removing the participant this merge added is the inverse.
   */
  async onContactUnmerged(_tx: DbTransaction, _event: MergeParticipantsEvent): Promise<void> {
    await Promise.resolve();
  }
}

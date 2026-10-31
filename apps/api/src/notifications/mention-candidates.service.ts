import type { DbTransaction } from '@helpdock/db';
import type { MentionCandidateList, PresenceMap } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { mentionCandidates } from './mention-candidates.js';
import type { NotificationsRepository } from './notifications.repository.js';

/** Presence, read the way the assignee picker reads it. */
export interface PresenceMapReader {
  map(brandId: string): Promise<PresenceMap>;
}

/** The people the `@` picker offers on one ticket (M14-15). */
export class MentionCandidatesService {
  readonly #repository: NotificationsRepository;
  readonly #presence: PresenceMapReader;

  constructor(repository: NotificationsRepository, presence: PresenceMapReader) {
    this.#repository = repository;
    this.#presence = presence;
  }

  async list(
    tx: DbTransaction,
    input: { brandId: string; ticketId: string; actorId: string; query: string },
  ): Promise<MentionCandidateList> {
    // Read through the caller's transaction, so a ticket of a department they
    // cannot see is "not found", as everywhere else.
    const ticket = await this.#repository.ticket(tx, input.ticketId);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }
    const [members, presence] = await Promise.all([
      this.#repository.members(tx, input.brandId),
      this.#presence.map(input.brandId),
    ]);

    return {
      candidates: mentionCandidates({
        members,
        departmentId: ticket.departmentId,
        actorId: input.actorId,
        presence,
        query: input.query,
      }),
    };
  }
}

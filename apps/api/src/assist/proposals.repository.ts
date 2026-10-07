import {
  type ArticleProposal,
  articleProposals,
  type DbTransaction,
  type NewArticleProposal,
  tickets,
  users,
} from '@helpdock/db';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/** Article proposals (M7-05), read under the reader's department policy. */

const proposer = alias(users, 'proposer');
const decider = alias(users, 'decider');

export interface ProposalRow {
  readonly proposal: ArticleProposal;
  readonly ticketPrefix: string;
  readonly ticketNumber: number;
  readonly ticketSubject: string;
  readonly ticketClosedAt: Date | null;
  readonly proposedByName: string | null;
  readonly decidedByName: string | null;
}

/** The most a list returns; a brand with more waiting has a backlog to clear first. */
const LIST_LIMIT = 200;

export class ProposalsRepository {
  #select(tx: DbTransaction) {
    return tx
      .select({
        proposal: articleProposals,
        ticketPrefix: tickets.prefix,
        ticketNumber: tickets.number,
        ticketSubject: tickets.subject,
        ticketClosedAt: tickets.closedAt,
        proposedByName: proposer.name,
        decidedByName: decider.name,
      })
      .from(articleProposals)
      .innerJoin(tickets, eq(tickets.id, articleProposals.ticketId))
      .leftJoin(proposer, eq(proposer.id, articleProposals.proposedBy))
      .leftJoin(decider, eq(decider.id, articleProposals.decidedBy));
  }

  list(tx: DbTransaction, decided: boolean): Promise<ProposalRow[]> {
    return this.#select(tx)
      .where(
        decided
          ? inArray(articleProposals.status, ['approved', 'rejected'])
          : eq(articleProposals.status, 'waiting'),
      )
      .orderBy(desc(articleProposals.proposedAt))
      .limit(LIST_LIMIT);
  }

  async waitingCount(tx: DbTransaction): Promise<number> {
    const [row] = await tx
      .select({ value: count() })
      .from(articleProposals)
      .where(eq(articleProposals.status, 'waiting'));
    return row?.value ?? 0;
  }

  async find(tx: DbTransaction, id: string): Promise<ProposalRow | undefined> {
    const [row] = await this.#select(tx).where(eq(articleProposals.id, id)).limit(1);
    return row;
  }

  async waitingFor(tx: DbTransaction, ticketId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: articleProposals.id })
      .from(articleProposals)
      .where(and(eq(articleProposals.ticketId, ticketId), eq(articleProposals.status, 'waiting')))
      .limit(1);
    return row !== undefined;
  }

  async insert(tx: DbTransaction, values: NewArticleProposal): Promise<string> {
    const [row] = await tx
      .insert(articleProposals)
      .values(values)
      .returning({ id: articleProposals.id });
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The proposal insert returned no row');
    }
    return row.id;
  }

  /** Decides a waiting proposal; false when another reviewer got there first. */
  async decide(
    tx: DbTransaction,
    id: string,
    values: Pick<
      ArticleProposal,
      'status' | 'decidedBy' | 'decidedAt' | 'rejectReason' | 'articleId' | 'sectionId' | 'locale'
    >,
  ): Promise<boolean> {
    const rows = await tx
      .update(articleProposals)
      .set(values)
      .where(and(eq(articleProposals.id, id), eq(articleProposals.status, 'waiting')))
      .returning({ id: articleProposals.id });
    return rows.length > 0;
  }
}

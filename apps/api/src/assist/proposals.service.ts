import { draftMarkdownToHtml, type PiiKind } from '@helpdock/ai';
import { sanitizeArticleHtml } from '@helpdock/channels';
import { auditLog, type DbTransaction } from '@helpdock/db';
import type {
  ProposalApproveRequest,
  ProposalApproveResult,
  ProposalCreateRequest,
  ProposalDetail,
  ProposalList,
  ProposalListQuery,
  ProposalRejectRequest,
  ProposalSummary,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { HelpCenterArticlesService } from '../help-center/articles.service.js';
import { writeTicketActivity } from '../tickets/ticket-activity.js';
import type { AssistRepository } from './assist.repository.js';
import { AssistFailure } from './assist-failure.js';
import type { ProposalRow, ProposalsRepository } from './proposals.repository.js';

/**
 * "Draft article from ticket" after the draft (M7-05, `Admin/Ticket-AI`
 * panels 5 and 6, `Admin/HelpCenter-ArticleApproval`): an agent sends the
 * draft for approval; a Team Leader of the ticket's department — or an
 * Admin — approves it into a **draft** article that opens in the editor, or
 * rejects it with a reason. Approving publishes nothing, and the assistant
 * cannot use the article until a person publishes it. Every step is audited.
 */

export interface ProposalContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
}

const summaryOf = (row: ProposalRow): ProposalSummary => ({
  id: row.proposal.id,
  title: row.proposal.title,
  locale: row.proposal.locale,
  status: row.proposal.status,
  ticket: {
    id: row.proposal.ticketId,
    reference: `${row.ticketPrefix}-${String(row.ticketNumber)}`,
  },
  proposedBy: row.proposedByName,
  proposedAt: row.proposal.proposedAt.toISOString(),
});

const citationsOf = (stored: readonly Record<string, unknown>[]) =>
  stored.flatMap((citation) =>
    typeof citation.title === 'string'
      ? [
          {
            title: citation.title,
            articleId: typeof citation.articleId === 'string' ? citation.articleId : null,
          },
        ]
      : [],
  );

const redactionKindsOf = (stored: unknown): PiiKind[] => {
  const kinds = new Set<PiiKind>();
  for (const entry of Array.isArray(stored) ? stored : []) {
    const kind = (entry as { kind?: unknown }).kind;
    if (kind === 'email' || kind === 'phone' || kind === 'card' || kind === 'iban') {
      kinds.add(kind);
    }
  }
  return [...kinds];
};

export class ProposalsService {
  readonly #proposals: ProposalsRepository;
  readonly #assist: AssistRepository;
  readonly #articles: HelpCenterArticlesService;
  readonly #now: () => Date;

  constructor(
    proposals: ProposalsRepository,
    assist: AssistRepository,
    articles: HelpCenterArticlesService,
    now: () => Date = () => new Date(),
  ) {
    this.#proposals = proposals;
    this.#assist = assist;
    this.#articles = articles;
    this.#now = now;
  }

  /** The agent's "Send for approval": a closed ticket they can see, one waiting proposal at a time. */
  async create(
    context: ProposalContext,
    ticketId: string,
    request: ProposalCreateRequest,
  ): Promise<ProposalDetail> {
    const { tx, brandId, actorId } = context;
    const ticket = await this.#assist.ticket(tx, ticketId);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }
    if (!ticket.closed) {
      throw new AssistFailure('ticket-not-closed');
    }
    if (await this.#proposals.waitingFor(tx, ticketId)) {
      throw new AssistFailure('proposal-exists');
    }
    const id = await this.#proposals.insert(tx, {
      brandId,
      ticketId,
      departmentId: ticket.departmentId,
      sectionId: request.sectionId,
      locale: request.locale,
      title: request.title,
      bodyMarkdown: request.bodyMarkdown,
      note: request.note,
      messageCount: request.messageCount,
      citations: request.citations.map((citation) => ({ ...citation })),
      aiCallId: request.callId,
      proposedBy: actorId,
    });
    await this.#audit(context, 'help_center.proposal.created', id, { ticketId });
    // The thread's "Lina proposed an article · waiting for approval" line.
    await writeTicketActivity(tx, {
      brandId,
      ticketId,
      departmentId: ticket.departmentId,
      actor: { actorType: 'staff', actorId, via: 'ui' },
      action: 'ticket.article_proposed',
      to: { proposalId: id, title: request.title },
    });
    return this.get(tx, id);
  }

  async list(tx: DbTransaction, query: ProposalListQuery): Promise<ProposalList> {
    const rows = await this.#proposals.list(tx, query.status === 'decided');
    return { items: rows.map(summaryOf), waiting: await this.#proposals.waitingCount(tx) };
  }

  async get(tx: DbTransaction, id: string): Promise<ProposalDetail> {
    const row = await this.#require(tx, id);
    const { proposal } = row;
    const call =
      proposal.aiCallId === null ? undefined : await this.#assist.call(tx, proposal.aiCallId);
    return {
      ...summaryOf(row),
      sectionId: proposal.sectionId,
      bodyMarkdown: proposal.bodyMarkdown,
      bodyHtml: sanitizeArticleHtml(draftMarkdownToHtml(proposal.bodyMarkdown), {
        brandId: proposal.brandId,
      }).html,
      note: proposal.note,
      messageCount: proposal.messageCount,
      ticketSubject: row.ticketSubject,
      ticketClosedAt: row.ticketClosedAt?.toISOString() ?? null,
      citations: citationsOf(proposal.citations),
      call:
        call === undefined
          ? null
          : {
              model: call.model,
              costUsd: call.costUsd,
              redactionCount: Array.isArray(call.redactions) ? call.redactions.length : 0,
              redactionKinds: redactionKindsOf(call.redactions),
            },
      decidedBy: row.decidedByName,
      decidedAt: proposal.decidedAt?.toISOString() ?? null,
      rejectReason: proposal.rejectReason,
      articleId: proposal.articleId,
    };
  }

  /** A draft article in the chosen section, language and visibility, and the proposal closed. */
  async approve(
    context: ProposalContext,
    id: string,
    request: ProposalApproveRequest,
  ): Promise<ProposalApproveResult> {
    const { proposal } = await this.#requireWaiting(context.tx, id);
    const created = await this.#articles.create(context, {
      sectionId: request.sectionId,
      locale: request.locale,
      title: proposal.title,
    });
    await this.#articles.save(context, created.id, request.locale, {
      title: proposal.title,
      description: '',
      bodyHtml: draftMarkdownToHtml(proposal.bodyMarkdown),
    });
    await this.#articles.setVisibility(context, created.id, request.locale, request.visibility);
    await this.#settle(context, id, {
      status: 'approved',
      articleId: created.id,
      rejectReason: null,
      sectionId: request.sectionId,
      locale: request.locale,
    });
    await this.#audit(context, 'help_center.proposal.approved', id, { articleId: created.id });
    return { articleId: created.id };
  }

  async reject(
    context: ProposalContext,
    id: string,
    request: ProposalRejectRequest,
  ): Promise<ProposalDetail> {
    const { proposal } = await this.#requireWaiting(context.tx, id);
    await this.#settle(context, id, {
      status: 'rejected',
      articleId: null,
      rejectReason: request.reason,
      sectionId: proposal.sectionId,
      locale: proposal.locale,
    });
    await this.#audit(context, 'help_center.proposal.rejected', id, { reason: request.reason });
    return this.get(context.tx, id);
  }

  async #settle(
    { tx, actorId }: ProposalContext,
    id: string,
    values: {
      readonly status: 'approved' | 'rejected';
      readonly articleId: string | null;
      readonly rejectReason: string | null;
      readonly sectionId: string | null;
      readonly locale: 'en' | 'ar';
    },
  ): Promise<void> {
    const settled = await this.#proposals.decide(tx, id, {
      ...values,
      decidedBy: actorId,
      decidedAt: this.#now(),
    });
    if (!settled) {
      throw new AssistFailure('proposal-decided');
    }
  }

  async #require(tx: DbTransaction, id: string): Promise<ProposalRow> {
    const row = await this.#proposals.find(tx, id);
    if (row === undefined) {
      throw new NotFoundException('No such proposal');
    }
    return row;
  }

  async #requireWaiting(tx: DbTransaction, id: string): Promise<ProposalRow> {
    const row = await this.#require(tx, id);
    if (row.proposal.status !== 'waiting') {
      throw new AssistFailure('proposal-decided');
    }
    return row;
  }

  async #audit(
    { tx, brandId, actorId }: ProposalContext,
    action: string,
    proposalId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId,
      action,
      targetType: 'article_proposal',
      targetId: proposalId,
      meta,
    });
  }
}

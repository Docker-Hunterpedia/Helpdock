import type {
  AssistCallMeta,
  AssistState,
  DismissSuggestionRequest,
  DismissSuggestionResult,
  DraftArticleResult,
  FieldSuggestions,
  ProposalApproveRequest,
  ProposalApproveResult,
  ProposalCreateRequest,
  ProposalDetail,
  ProposalList,
  ProposalListQuery,
  RewriteRequest,
  RewriteResult,
  SuggestFieldsResult,
  SuggestReplyResult,
  SummaryResult,
  TicketRedactions,
  TicketTranscripts,
  TranslateRequest,
  TranslateResult,
} from '@helpdock/schemas';
import type { HelpCenterApi } from '../help-center/api.js';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import type { TicketsApi } from '../tickets/api.js';
import { type AssistApi, AssistError } from './api.js';

/**
 * The assist fixture: deterministic answers in place of a model, so the unit
 * suites and the mock Playwright projects can drive every state of
 * `Admin/Ticket-AI` and `Admin/HelpCenter-ArticleApproval`. It reads the
 * ticket fixture for whether a ticket is closed and what its customer wrote,
 * and the help center fixture is where an approved proposal's draft goes.
 */

/** The fixture's two tags, as `ticketing/mock-api.ts` seeds them. */
export const MOCK_REFUND_TAG_ID = '0192c3f0-1a2b-7c3d-8e4f-000000000101';
const BILLING_ID = MOCK_DEPARTMENTS[1]?.id ?? '';

export type MockBudget = 'ok' | 'warning' | 'exceeded' | 'exceeded-keep';

export interface MockAssistOptions {
  readonly tickets?: TicketsApi | undefined;
  readonly helpCenter?: HelpCenterApi | undefined;
  readonly budget?: MockBudget;
  readonly enabled?: boolean;
  /** Makes the next model call fail with this reason. */
  readonly failWith?: AssistError['reason'] | null;
}

const meta = (costUsd: number, redactions = 0): AssistCallMeta => ({
  callId: crypto.randomUUID(),
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  tokensIn: 1_842,
  tokensOut: 236,
  costUsd,
  redactionCount: redactions,
  redactionKinds: redactions === 0 ? [] : ['phone'],
});

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, 'EMAIL'],
  [/\b(?:\d[ -]?){13,19}\b/g, 'CARD'],
  [/\+?\d[\d ]{8,}\d/g, 'PHONE'],
];

/** Enough of the api's redactor for the fixture's messages. */
export const mockRedact = (text: string): { text: string; kinds: string[] } => {
  const kinds: string[] = [];
  let redacted = text;
  for (const [pattern, kind] of PATTERNS) {
    let count = 0;
    redacted = redacted.replace(pattern, () => {
      count += 1;
      return `[${kind}_${String(count)}]`;
    });
    if (count > 0) {
      kinds.push(kind.toLowerCase());
    }
  }
  return { text: redacted, kinds };
};

const budgetWindow = (level: 'warning' | 'exceeded'): AssistState['budget'][number] => ({
  period: 'month',
  level,
  spentUsd: level === 'warning' ? 164.2 : 200,
  limitUsd: 200,
  resetsAt: '2026-11-01T00:00:00.000Z',
});

export class MockAssistApi implements AssistApi {
  readonly #tickets: TicketsApi | undefined;
  readonly #helpCenter: HelpCenterApi | undefined;
  budget: MockBudget;
  enabled: boolean;
  failWith: AssistError['reason'] | null;
  readonly #suggestions = new Map<string, FieldSuggestions>();
  readonly #proposals = new Map<string, ProposalDetail>();
  /** Every call, for the suites to assert on. */
  readonly calls: { readonly name: string; readonly args: unknown }[] = [];

  constructor(options: MockAssistOptions = {}) {
    this.#tickets = options.tickets;
    this.#helpCenter = options.helpCenter;
    this.budget = options.budget ?? 'ok';
    this.enabled = options.enabled ?? true;
    this.failWith = options.failWith ?? null;
  }

  async state(brandId: string, ticketId: string): Promise<AssistState> {
    const ticket = await this.#ticket(brandId, ticketId);
    const proposal = [...this.#proposals.values()]
      .filter((candidate) => candidate.ticket.id === ticketId)
      .at(-1);
    return {
      enabled: this.enabled,
      blocked: this.budget === 'exceeded' ? 'budget-exceeded' : null,
      budget:
        this.budget === 'ok'
          ? []
          : [budgetWindow(this.budget === 'warning' ? 'warning' : 'exceeded')],
      keepAssistAfterHardStop: this.budget !== 'exceeded',
      ticketClosed: ticket?.status.systemState === 'closed',
      proposal: proposal === undefined ? null : { id: proposal.id, status: proposal.status },
      suggestions: this.#suggestions.get(ticketId) ?? null,
    };
  }

  async suggestReply(_brandId: string, ticketId: string): Promise<SuggestReplyResult> {
    this.#called('suggestReply', { ticketId });
    return {
      text: 'Hello, refunds to a card arrive within five business days [1]. Refunds over €500 are checked by a team leader first [2].',
      locale: 'en',
      citations: [
        {
          marker: 1,
          title: 'Refund timelines',
          sourceKind: 'article',
          visibility: 'public',
          url: 'https://help.example.com/en/articles/refund-timelines',
          articleId: null,
          page: null,
        },
        {
          marker: 2,
          title: 'Ops handbook.pdf',
          sourceKind: 'file',
          visibility: 'internal',
          url: null,
          articleId: null,
          page: 12,
        },
      ],
      droppedCitations: 0,
      meta: meta(0.0031, 1),
    };
  }

  async summarize(_brandId: string, ticketId: string, locale: 'en' | 'ar'): Promise<SummaryResult> {
    this.#called('summarize', { ticketId, locale });
    return {
      points:
        locale === 'ar'
          ? ['يسأل العميل عن استرداد المبلغ.', 'لم يرد أحد بعد.']
          : ['The customer asks where their refund is.', 'Nobody has replied yet.'],
      messageCount: 5,
      generatedAt: new Date().toISOString(),
      meta: meta(0.0012),
    };
  }

  async suggestFields(_brandId: string, ticketId: string): Promise<SuggestFieldsResult> {
    this.#called('suggestFields', { ticketId });
    const suggestions: FieldSuggestions = {
      tagIds: [MOCK_REFUND_TAG_ID],
      priority: 'high',
      departmentId: BILLING_ID,
      source: 'assist',
      createdAt: new Date().toISOString(),
    };
    this.#suggestions.set(ticketId, suggestions);
    return { suggestions, meta: meta(0.0008) };
  }

  async dismissSuggestion(
    _brandId: string,
    ticketId: string,
    request: DismissSuggestionRequest,
  ): Promise<DismissSuggestionResult> {
    this.#called('dismissSuggestion', { ticketId, ...request });
    const held = this.#suggestions.get(ticketId);
    if (held === undefined) {
      return { suggestions: null };
    }
    const next: FieldSuggestions = {
      ...held,
      tagIds:
        request.field === 'tag' ? held.tagIds.filter((id) => id !== request.tagId) : held.tagIds,
      priority: request.field === 'priority' ? null : held.priority,
      departmentId: request.field === 'department' ? null : held.departmentId,
    };
    if (next.tagIds.length === 0 && next.priority === null && next.departmentId === null) {
      this.#suggestions.delete(ticketId);
      return { suggestions: null };
    }
    this.#suggestions.set(ticketId, next);
    return { suggestions: next };
  }

  async translate(
    _brandId: string,
    ticketId: string,
    request: TranslateRequest,
  ): Promise<TranslateResult> {
    this.#called('translate', { ticketId, ...request });
    return {
      text:
        request.target === 'ar'
          ? 'مرحباً، يصل استرداد البطاقة خلال خمسة أيام عمل.'
          : 'Hello, how much is shipping to Germany for my order?',
      target: request.target,
      meta: meta(0.0004),
    };
  }

  async rewrite(
    _brandId: string,
    ticketId: string,
    request: RewriteRequest,
  ): Promise<RewriteResult> {
    this.#called('rewrite', { ticketId, ...request });
    const byTone = {
      friendlier: `Hi there! ${request.text} Thanks so much for your patience.`,
      formal: `Dear customer, ${request.text} Thank you for your patience.`,
      shorter: request.text.split(/[.!?]/)[0]?.trim() ?? request.text,
    };
    return { text: byTone[request.tone], tone: request.tone, meta: meta(0.0006) };
  }

  async draftArticle(
    brandId: string,
    ticketId: string,
    locale: 'en' | 'ar',
  ): Promise<DraftArticleResult> {
    this.#called('draftArticle', { ticketId, locale });
    if ((await this.#ticket(brandId, ticketId))?.status.systemState !== 'closed') {
      throw new AssistError('ticket-not-closed');
    }
    return {
      title: 'Customs and VAT on clothing shipped to Germany',
      bodyMarkdown:
        'Clothing sent to Germany with a declared value under €150 is not charged customs duty.\n\n## Who handles clearance\n\nWe clear every EU parcel on your behalf.',
      locale,
      messageCount: 7,
      citations: [],
      meta: meta(0.0042, 2),
    };
  }

  async propose(
    brandId: string,
    ticketId: string,
    request: ProposalCreateRequest,
  ): Promise<ProposalDetail> {
    this.#called('propose', { ticketId, ...request });
    if (
      [...this.#proposals.values()].some(
        (proposal) => proposal.ticket.id === ticketId && proposal.status === 'waiting',
      )
    ) {
      throw new AssistError('proposal-exists');
    }
    const ticket = await this.#ticket(brandId, ticketId);
    const proposal: ProposalDetail = {
      id: crypto.randomUUID(),
      title: request.title,
      locale: request.locale,
      status: 'waiting',
      ticket: {
        id: ticketId,
        reference: ticket === undefined ? 'HD-0' : `${ticket.prefix}-${String(ticket.number)}`,
      },
      proposedBy: 'Lina Haddad',
      proposedAt: new Date().toISOString(),
      sectionId: request.sectionId,
      bodyMarkdown: request.bodyMarkdown,
      bodyHtml: request.bodyMarkdown
        .split(/\n{2,}/)
        .map((block) =>
          block.startsWith('## ') ? `<h2>${block.slice(3)}</h2>` : `<p>${block}</p>`,
        )
        .join(''),
      note: request.note,
      messageCount: request.messageCount,
      ticketSubject: ticket?.subject ?? '',
      ticketClosedAt: ticket?.closedAt ?? null,
      citations: request.citations,
      call: {
        model: 'claude-haiku-4-5',
        costUsd: 0.0042,
        redactionCount: 2,
        redactionKinds: ['email', 'phone'],
      },
      decidedBy: null,
      decidedAt: null,
      rejectReason: null,
      articleId: null,
    };
    this.#proposals.set(proposal.id, proposal);
    return proposal;
  }

  async redactions(brandId: string, ticketId: string): Promise<TicketRedactions> {
    const messages = (await this.#tickets?.messages(brandId, ticketId))?.messages ?? [];
    return {
      items: messages
        .filter((message) => message.authorType === 'contact')
        .flatMap((message) => {
          const redacted = mockRedact(message.bodyText);
          return redacted.kinds.length === 0
            ? []
            : [
                {
                  messageId: message.id,
                  redactedText: redacted.text,
                  count: (redacted.text.match(/\[[A-Z]+_\d+\]/g) ?? []).length,
                  kinds: redacted.kinds as ('email' | 'phone' | 'card' | 'iban')[],
                },
              ];
        }),
    };
  }

  async transcripts(brandId: string, ticketId: string): Promise<TicketTranscripts> {
    const messages = (await this.#tickets?.messages(brandId, ticketId))?.messages ?? [];
    return {
      items: messages
        .flatMap((message) => message.attachments)
        .filter((attachment) => attachment.kind === 'audio')
        .map((attachment) => ({
          attachmentId: attachment.id,
          status: 'done' as const,
          text: 'وهل يجب أن أدفع رسوم جمارك عند الاستلام في برلين؟',
          locale: 'ar' as const,
          language: 'arabic',
        })),
    };
  }

  async proposals(_brandId: string, query: ProposalListQuery): Promise<ProposalList> {
    const all = [...this.#proposals.values()].reverse();
    return {
      items: all.filter((proposal) =>
        query.status === 'waiting' ? proposal.status === 'waiting' : proposal.status !== 'waiting',
      ),
      waiting: all.filter((proposal) => proposal.status === 'waiting').length,
    };
  }

  async proposal(_brandId: string, proposalId: string): Promise<ProposalDetail> {
    const found = this.#proposals.get(proposalId);
    if (found === undefined) {
      throw new Error('not found');
    }
    return found;
  }

  async approve(
    brandId: string,
    proposalId: string,
    request: ProposalApproveRequest,
  ): Promise<ProposalApproveResult> {
    const proposal = await this.#waiting(brandId, proposalId);
    const created = await this.#helpCenter?.createArticle(brandId, {
      sectionId: request.sectionId,
      locale: request.locale,
      title: proposal.title,
    });
    const articleId = created?.id ?? crypto.randomUUID();
    this.#proposals.set(proposalId, {
      ...proposal,
      status: 'approved',
      articleId,
      decidedBy: 'Karim',
      decidedAt: new Date().toISOString(),
    });
    return { articleId };
  }

  async reject(brandId: string, proposalId: string, reason: string): Promise<ProposalDetail> {
    const proposal = await this.#waiting(brandId, proposalId);
    const rejected: ProposalDetail = {
      ...proposal,
      status: 'rejected',
      rejectReason: reason,
      decidedBy: 'Karim',
      decidedAt: new Date().toISOString(),
    };
    this.#proposals.set(proposalId, rejected);
    return rejected;
  }

  /** A proposal waiting for review, for a suite that starts on the Proposals tab. */
  seedProposal(proposal: ProposalDetail): void {
    this.#proposals.set(proposal.id, proposal);
  }

  async #waiting(brandId: string, proposalId: string): Promise<ProposalDetail> {
    const proposal = await this.proposal(brandId, proposalId);
    if (proposal.status !== 'waiting') {
      throw new AssistError('proposal-decided');
    }
    return proposal;
  }

  async #ticket(brandId: string, ticketId: string) {
    try {
      return (await this.#tickets?.ticket(brandId, ticketId))?.ticket;
    } catch {
      return undefined;
    }
  }

  #called(name: string, args: unknown): void {
    this.calls.push({ name, args });
    if (this.failWith !== null) {
      throw new AssistError(this.failWith);
    }
  }
}

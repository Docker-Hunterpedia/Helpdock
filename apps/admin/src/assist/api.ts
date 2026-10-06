import type {
  AssistRefusal,
  AssistState,
  DismissSuggestionRequest,
  DismissSuggestionResult,
  DraftArticleResult,
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

/**
 * Agent assist on a ticket (M7-05), the transcripts of its voice notes
 * (M7-09), "Show redacted" (M7-08), and Help center › Proposals. `MockAssistApi`
 * is the fixture the unit tests and the mock Playwright projects run against;
 * `HttpAssistApi` is the real service. Refusals cross as an
 * {@link AssistError} whose reason picks a sentence.
 */
export interface AssistApi {
  state(brandId: string, ticketId: string): Promise<AssistState>;
  suggestReply(brandId: string, ticketId: string): Promise<SuggestReplyResult>;
  summarize(brandId: string, ticketId: string, locale: 'en' | 'ar'): Promise<SummaryResult>;
  suggestFields(brandId: string, ticketId: string): Promise<SuggestFieldsResult>;
  dismissSuggestion(
    brandId: string,
    ticketId: string,
    request: DismissSuggestionRequest,
  ): Promise<DismissSuggestionResult>;
  translate(brandId: string, ticketId: string, request: TranslateRequest): Promise<TranslateResult>;
  rewrite(brandId: string, ticketId: string, request: RewriteRequest): Promise<RewriteResult>;
  draftArticle(brandId: string, ticketId: string, locale: 'en' | 'ar'): Promise<DraftArticleResult>;
  propose(
    brandId: string,
    ticketId: string,
    request: ProposalCreateRequest,
  ): Promise<ProposalDetail>;
  redactions(brandId: string, ticketId: string): Promise<TicketRedactions>;
  transcripts(brandId: string, ticketId: string): Promise<TicketTranscripts>;

  proposals(brandId: string, query: ProposalListQuery): Promise<ProposalList>;
  proposal(brandId: string, proposalId: string): Promise<ProposalDetail>;
  approve(
    brandId: string,
    proposalId: string,
    request: ProposalApproveRequest,
  ): Promise<ProposalApproveResult>;
  reject(brandId: string, proposalId: string, reason: string): Promise<ProposalDetail>;
}

export const assistKeys = {
  state: (brandId: string, ticketId: string) => ['assist', brandId, ticketId, 'state'] as const,
  redactions: (brandId: string, ticketId: string) =>
    ['assist', brandId, ticketId, 'redactions'] as const,
  transcripts: (brandId: string, ticketId: string) =>
    ['assist', brandId, ticketId, 'transcripts'] as const,
  proposals: (brandId: string) => ['assist', brandId, 'proposals'] as const,
  proposalList: (brandId: string, status: ProposalListQuery['status']) =>
    ['assist', brandId, 'proposals', status] as const,
  proposal: (brandId: string, proposalId: string) =>
    ['assist', brandId, 'proposals', 'one', proposalId] as const,
};

export class AssistError extends Error {
  readonly reason: AssistRefusal;

  constructor(reason: AssistRefusal) {
    super(`assist: ${reason}`);
    this.name = 'AssistError';
    this.reason = reason;
  }
}

export const isAssistError = (error: unknown): error is AssistError => error instanceof AssistError;

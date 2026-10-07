import {
  type AssistState,
  assistStateSchema,
  type DismissSuggestionRequest,
  type DismissSuggestionResult,
  type DraftArticleResult,
  dismissSuggestionResultSchema,
  draftArticleResultSchema,
  type ProposalApproveRequest,
  type ProposalApproveResult,
  type ProposalCreateRequest,
  type ProposalDetail,
  type ProposalList,
  type ProposalListQuery,
  proposalApproveResultSchema,
  proposalDetailSchema,
  proposalListSchema,
  type RewriteRequest,
  type RewriteResult,
  rewriteResultSchema,
  type SuggestFieldsResult,
  type SuggestReplyResult,
  type SummaryResult,
  suggestFieldsResultSchema,
  suggestReplyResultSchema,
  summaryResultSchema,
  type TicketRedactions,
  type TicketTranscripts,
  type TranslateRequest,
  type TranslateResult,
  ticketRedactionsSchema,
  ticketTranscriptsSchema,
  translateResultSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { AssistApi } from './api.js';

/**
 * The real assist service. It shares the app's {@link HttpTransport}, and
 * parses every answer through the schema the api declared it with.
 */
export class HttpAssistApi implements AssistApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async state(brandId: string, ticketId: string): Promise<AssistState> {
    return assistStateSchema.parse(
      await this.#transport.request('GET', this.#ticket(brandId, ticketId, 'assist')),
    );
  }

  async suggestReply(brandId: string, ticketId: string): Promise<SuggestReplyResult> {
    return suggestReplyResultSchema.parse(
      await this.#transport.request('POST', this.#assist(brandId, ticketId, 'suggest-reply')),
    );
  }

  async summarize(brandId: string, ticketId: string, locale: 'en' | 'ar'): Promise<SummaryResult> {
    return summaryResultSchema.parse(
      await this.#transport.request('POST', this.#assist(brandId, ticketId, 'summarize'), {
        locale,
      }),
    );
  }

  async suggestFields(brandId: string, ticketId: string): Promise<SuggestFieldsResult> {
    return suggestFieldsResultSchema.parse(
      await this.#transport.request('POST', this.#assist(brandId, ticketId, 'suggest-fields')),
    );
  }

  async dismissSuggestion(
    brandId: string,
    ticketId: string,
    request: DismissSuggestionRequest,
  ): Promise<DismissSuggestionResult> {
    return dismissSuggestionResultSchema.parse(
      await this.#transport.request(
        'POST',
        this.#assist(brandId, ticketId, 'suggestions/dismiss'),
        request,
      ),
    );
  }

  async translate(
    brandId: string,
    ticketId: string,
    request: TranslateRequest,
  ): Promise<TranslateResult> {
    return translateResultSchema.parse(
      await this.#transport.request('POST', this.#assist(brandId, ticketId, 'translate'), request),
    );
  }

  async rewrite(
    brandId: string,
    ticketId: string,
    request: RewriteRequest,
  ): Promise<RewriteResult> {
    return rewriteResultSchema.parse(
      await this.#transport.request('POST', this.#assist(brandId, ticketId, 'rewrite'), request),
    );
  }

  async draftArticle(
    brandId: string,
    ticketId: string,
    locale: 'en' | 'ar',
  ): Promise<DraftArticleResult> {
    return draftArticleResultSchema.parse(
      await this.#transport.request('POST', this.#assist(brandId, ticketId, 'draft-article'), {
        locale,
      }),
    );
  }

  async propose(
    brandId: string,
    ticketId: string,
    request: ProposalCreateRequest,
  ): Promise<ProposalDetail> {
    return proposalDetailSchema.parse(
      await this.#transport.request('POST', this.#assist(brandId, ticketId, 'proposals'), request),
    );
  }

  async redactions(brandId: string, ticketId: string): Promise<TicketRedactions> {
    return ticketRedactionsSchema.parse(
      await this.#transport.request('GET', this.#ticket(brandId, ticketId, 'ai/redactions')),
    );
  }

  async transcripts(brandId: string, ticketId: string): Promise<TicketTranscripts> {
    return ticketTranscriptsSchema.parse(
      await this.#transport.request('GET', this.#ticket(brandId, ticketId, 'transcripts')),
    );
  }

  async proposals(brandId: string, query: ProposalListQuery): Promise<ProposalList> {
    return proposalListSchema.parse(
      await this.#transport.request('GET', `${this.#proposals(brandId)}?status=${query.status}`),
    );
  }

  async proposal(brandId: string, proposalId: string): Promise<ProposalDetail> {
    return proposalDetailSchema.parse(
      await this.#transport.request('GET', `${this.#proposals(brandId)}/${proposalId}`),
    );
  }

  async approve(
    brandId: string,
    proposalId: string,
    request: ProposalApproveRequest,
  ): Promise<ProposalApproveResult> {
    return proposalApproveResultSchema.parse(
      await this.#transport.request(
        'POST',
        `${this.#proposals(brandId)}/${proposalId}/approve`,
        request,
      ),
    );
  }

  async reject(brandId: string, proposalId: string, reason: string): Promise<ProposalDetail> {
    return proposalDetailSchema.parse(
      await this.#transport.request('POST', `${this.#proposals(brandId)}/${proposalId}/reject`, {
        reason,
      }),
    );
  }

  #ticket(brandId: string, ticketId: string, path: string): string {
    return `/api/brands/${brandId}/tickets/${ticketId}/${path}`;
  }

  #assist(brandId: string, ticketId: string, path: string): string {
    return this.#ticket(brandId, ticketId, `assist/${path}`);
  }

  #proposals(brandId: string): string {
    return `/api/brands/${brandId}/help-center/proposals`;
  }
}

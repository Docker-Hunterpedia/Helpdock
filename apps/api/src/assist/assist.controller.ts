import type {
  AssistState,
  DismissSuggestionResult,
  DraftArticleResult,
  ProposalDetail,
  RewriteResult,
  SuggestFieldsResult,
  SuggestReplyResult,
  SummaryResult,
  TicketRedactions,
  TicketTranscripts,
  TranslateResult,
} from '@helpdock/schemas';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { StepTransactions } from '../tenant/step-transactions.js';
import { AssistService } from './assist.service.js';
import { AssistStateService } from './assist-state.service.js';
import {
  AssistParamDto,
  AssistStateDto,
  DismissSuggestionRequestDto,
  DismissSuggestionResultDto,
  DraftArticleRequestDto,
  DraftArticleResultDto,
  ProposalCreateRequestDto,
  ProposalDetailDto,
  RewriteRequestDto,
  RewriteResultDto,
  SuggestFieldsResultDto,
  SuggestReplyResultDto,
  SummarizeRequestDto,
  SummaryResultDto,
  TicketRedactionsDto,
  TicketTranscriptsDto,
  TranslateRequestDto,
  TranslateResultDto,
} from './dto.js';
import { ProposalsService } from './proposals.service.js';

/**
 * Agent assist on a ticket (M7-05, `Admin/Ticket-AI`), the transcripts of its
 * voice notes (M7-09) and "Show redacted" (M7-08).
 *
 * Every model call is `ticket:write` — assist is the composer's, an agent's
 * tool, and a Viewer is never offered it — and runs under
 * `@StepTransactions()`: the ticket is read under the agent's own department
 * policy, then the model is asked with no transaction open (ADR 0021).
 * Reading transcripts and redactions is `ticket:read`, under the ticket's
 * policy like the thread itself.
 */
@Controller('api/brands/:brandId/tickets/:ticketId')
export class AssistController {
  readonly #assist: AssistService;
  readonly #state: AssistStateService;
  readonly #proposals: ProposalsService;

  constructor(
    @Inject(AssistService) assist: AssistService,
    @Inject(AssistStateService) state: AssistStateService,
    @Inject(ProposalsService) proposals: ProposalsService,
  ) {
    this.#assist = assist;
    this.#state = state;
    this.#proposals = proposals;
  }

  @Get('assist')
  @Requires('ticket:write')
  @ZodSerializerDto(AssistStateDto)
  state(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
  ): Promise<AssistState> {
    return this.#state.state(getTx(), brandId, ticketId);
  }

  @Post('assist/suggest-reply')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @StepTransactions()
  @ZodSerializerDto(SuggestReplyResultDto)
  suggestReply(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
  ): Promise<SuggestReplyResult> {
    return this.#assist.suggestReply(brandId, ticketId);
  }

  @Post('assist/summarize')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @StepTransactions()
  @ZodSerializerDto(SummaryResultDto)
  summarize(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
    @Body(new ZodValidationPipe(SummarizeRequestDto)) body: SummarizeRequestDto,
  ): Promise<SummaryResult> {
    return this.#assist.summarize(brandId, ticketId, body.locale);
  }

  @Post('assist/suggest-fields')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @StepTransactions()
  @ZodSerializerDto(SuggestFieldsResultDto)
  suggestFields(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
  ): Promise<SuggestFieldsResult> {
    return this.#assist.suggestFields(brandId, ticketId);
  }

  @Post('assist/suggestions/dismiss')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @ZodSerializerDto(DismissSuggestionResultDto)
  async dismiss(
    @Param(new ZodValidationPipe(AssistParamDto)) { ticketId }: AssistParamDto,
    @Body(new ZodValidationPipe(DismissSuggestionRequestDto)) body: DismissSuggestionRequestDto,
  ): Promise<DismissSuggestionResult> {
    return { suggestions: await this.#state.dismiss(getTx(), ticketId, body) };
  }

  @Post('assist/translate')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @StepTransactions()
  @ZodSerializerDto(TranslateResultDto)
  translate(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
    @Body(new ZodValidationPipe(TranslateRequestDto)) body: TranslateRequestDto,
  ): Promise<TranslateResult> {
    return this.#assist.translate(brandId, ticketId, body);
  }

  @Post('assist/rewrite')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @StepTransactions()
  @ZodSerializerDto(RewriteResultDto)
  rewrite(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
    @Body(new ZodValidationPipe(RewriteRequestDto)) body: RewriteRequestDto,
  ): Promise<RewriteResult> {
    return this.#assist.rewrite(brandId, ticketId, body);
  }

  @Post('assist/draft-article')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @StepTransactions()
  @ZodSerializerDto(DraftArticleResultDto)
  draftArticle(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
    @Body(new ZodValidationPipe(DraftArticleRequestDto)) body: DraftArticleRequestDto,
  ): Promise<DraftArticleResult> {
    return this.#assist.draftArticle(brandId, ticketId, body.locale);
  }

  @Post('assist/proposals')
  @Requires('ticket:write')
  @ZodSerializerDto(ProposalDetailDto)
  propose(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
    @Body(new ZodValidationPipe(ProposalCreateRequestDto)) body: ProposalCreateRequestDto,
  ): Promise<ProposalDetail> {
    return this.#proposals.create(
      {
        tx: getTx(),
        brandId,
        actorId: requireStaffPrincipalId(requireRequestContext().principal),
      },
      ticketId,
      body,
    );
  }

  @Get('ai/redactions')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketRedactionsDto)
  redactions(
    @Param(new ZodValidationPipe(AssistParamDto)) { brandId, ticketId }: AssistParamDto,
  ): Promise<TicketRedactions> {
    return this.#state.redactions(getTx(), brandId, ticketId);
  }

  @Get('transcripts')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketTranscriptsDto)
  transcripts(
    @Param(new ZodValidationPipe(AssistParamDto)) { ticketId }: AssistParamDto,
  ): Promise<TicketTranscripts> {
    return this.#state.transcripts(getTx(), ticketId);
  }
}

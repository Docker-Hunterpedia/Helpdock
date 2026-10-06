import {
  assistParamSchema,
  assistStateSchema,
  brandIdParamSchema,
  dismissSuggestionRequestSchema,
  dismissSuggestionResultSchema,
  draftArticleRequestSchema,
  draftArticleResultSchema,
  proposalApproveRequestSchema,
  proposalApproveResultSchema,
  proposalCreateRequestSchema,
  proposalDetailSchema,
  proposalListQuerySchema,
  proposalListSchema,
  proposalParamSchema,
  proposalRejectRequestSchema,
  rewriteRequestSchema,
  rewriteResultSchema,
  suggestFieldsResultSchema,
  suggestReplyResultSchema,
  summarizeRequestSchema,
  summaryResultSchema,
  ticketRedactionsSchema,
  ticketTranscriptsSchema,
  translateRequestSchema,
  translateResultSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The assist schemas as Nest DTOs, for the reason `brands/dto.ts` gives. */
export class AssistParamDto extends createZodDto(assistParamSchema) {}
export class AssistStateDto extends createZodDto(assistStateSchema) {}
export class SuggestReplyResultDto extends createZodDto(suggestReplyResultSchema) {}
export class SummarizeRequestDto extends createZodDto(summarizeRequestSchema) {}
export class SummaryResultDto extends createZodDto(summaryResultSchema) {}
export class SuggestFieldsResultDto extends createZodDto(suggestFieldsResultSchema) {}
export class DismissSuggestionRequestDto extends createZodDto(dismissSuggestionRequestSchema) {}
export class DismissSuggestionResultDto extends createZodDto(dismissSuggestionResultSchema) {}
export class TranslateRequestDto extends createZodDto(translateRequestSchema) {}
export class TranslateResultDto extends createZodDto(translateResultSchema) {}
export class RewriteRequestDto extends createZodDto(rewriteRequestSchema) {}
export class RewriteResultDto extends createZodDto(rewriteResultSchema) {}
export class DraftArticleRequestDto extends createZodDto(draftArticleRequestSchema) {}
export class DraftArticleResultDto extends createZodDto(draftArticleResultSchema) {}
export class TicketRedactionsDto extends createZodDto(ticketRedactionsSchema) {}
export class TicketTranscriptsDto extends createZodDto(ticketTranscriptsSchema) {}

export class BrandParamDto extends createZodDto(brandIdParamSchema) {}
export class ProposalParamDto extends createZodDto(proposalParamSchema) {}
export class ProposalListQueryDto extends createZodDto(proposalListQuerySchema) {}
export class ProposalListDto extends createZodDto(proposalListSchema) {}
export class ProposalDetailDto extends createZodDto(proposalDetailSchema) {}
export class ProposalCreateRequestDto extends createZodDto(proposalCreateRequestSchema) {}
export class ProposalApproveRequestDto extends createZodDto(proposalApproveRequestSchema) {}
export class ProposalApproveResultDto extends createZodDto(proposalApproveResultSchema) {}
export class ProposalRejectRequestDto extends createZodDto(proposalRejectRequestSchema) {}

import {
  type MentionCandidateList,
  mentionCandidateListSchema,
  mentionCandidateQuerySchema,
  ticketParamSchema,
} from '@helpdock/schemas';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { MentionCandidatesService } from './mention-candidates.service.js';

class MentionTicketParamDto extends createZodDto(ticketParamSchema) {}
class MentionQueryDto extends createZodDto(mentionCandidateQuerySchema) {}
class MentionCandidateListDto extends createZodDto(mentionCandidateListSchema) {}

/**
 * The `@` picker's people (M14-15). `ticket:write`, since only someone who can
 * write a note needs it. The list holds names and handles of people who can see
 * the ticket's department; an email address is never returned.
 */
@Controller('api/brands/:brandId/tickets/:ticketId')
export class MentionCandidatesController {
  readonly #candidates: MentionCandidatesService;

  constructor(@Inject(MentionCandidatesService) candidates: MentionCandidatesService) {
    this.#candidates = candidates;
  }

  @Get('mention-candidates')
  @Requires('ticket:write')
  @ZodSerializerDto(MentionCandidateListDto)
  list(
    @Param(new ZodValidationPipe(MentionTicketParamDto)) {
      brandId,
      ticketId,
    }: MentionTicketParamDto,
    @Query(new ZodValidationPipe(MentionQueryDto)) query: MentionQueryDto,
  ): Promise<MentionCandidateList> {
    return this.#candidates.list(getTx(), {
      brandId,
      ticketId,
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
      query: query.q ?? '',
    });
  }
}

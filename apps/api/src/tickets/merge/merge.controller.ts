import type { TicketDetail, TicketMergeResult } from '@helpdock/schemas';
import {
  ticketDetailSchema,
  ticketMergeRequestSchema,
  ticketMergeResultSchema,
  ticketParamSchema,
  ticketSplitRequestSchema,
} from '@helpdock/schemas';
import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { Principal } from '../../auth/principal.js';
import { Requires } from '../../auth/route-declaration.js';
import { requireRequestContext } from '../../context/request-context.js';
import { MergeService } from './merge.service.js';

/**
 * M1-09 over HTTP: merge, unmerge and split (DOMAIN-RULES §2.4).
 *
 * All three are `ticket:write`, which every role but Viewer holds (§1.2: "Edits
 * tickets"). Which *tickets* that reaches is the policy's: a merge reads both
 * tickets through the request's transaction, so a primary in a department the
 * actor cannot read answers 404, the same as one that does not exist.
 *
 * Every path names the ticket the agent has open — the one the ⋯ menu was
 * opened on: the secondary for a merge and an unmerge, the original for a
 * split.
 */

class TicketMergeRequestDto extends createZodDto(ticketMergeRequestSchema) {}
class TicketMergeResultDto extends createZodDto(ticketMergeResultSchema) {}
class TicketSplitRequestDto extends createZodDto(ticketSplitRequestSchema) {}
class MergeTicketParamDto extends createZodDto(ticketParamSchema) {}
class SplitTicketDetailDto extends createZodDto(ticketDetailSchema) {}

@Controller('api/brands/:brandId/tickets/:ticketId')
export class MergeController {
  readonly #merges: MergeService;

  constructor(@Inject(MergeService) merges: MergeService) {
    this.#merges = merges;
  }

  /** Closes this ticket into `primaryTicketId`. */
  @Post('merge')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(TicketMergeResultDto)
  async merge(
    @Param(new ZodValidationPipe(MergeTicketParamDto)) { brandId, ticketId }: MergeTicketParamDto,
    @Body(new ZodValidationPipe(TicketMergeRequestDto)) body: TicketMergeRequestDto,
  ): Promise<TicketMergeResult> {
    return this.#merges.merge(brandId, principal(), ticketId, body);
  }

  /** Undoes the merge of this ticket, within 24 hours of it. */
  @Post('unmerge')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(TicketMergeResultDto)
  async unmerge(
    @Param(new ZodValidationPipe(MergeTicketParamDto)) { brandId, ticketId }: MergeTicketParamDto,
  ): Promise<TicketMergeResult> {
    return this.#merges.unmerge(brandId, principal(), ticketId);
  }

  /** Copies the named messages onto a new ticket, and answers with that ticket. */
  @Post('split')
  @Requires('ticket:write')
  @ZodSerializerDto(SplitTicketDetailDto)
  async split(
    @Param(new ZodValidationPipe(MergeTicketParamDto)) { brandId, ticketId }: MergeTicketParamDto,
    @Body(new ZodValidationPipe(TicketSplitRequestDto)) body: TicketSplitRequestDto,
  ): Promise<TicketDetail> {
    return this.#merges.split(brandId, principal(), ticketId, body);
  }
}

const principal = (): Principal => {
  const current = requireRequestContext().principal;
  /* c8 ignore next 3 -- the guard refuses the request before a handler runs. */
  if (current === null) {
    throw new Error('The authentication guard let an unauthenticated request through');
  }

  return current;
};

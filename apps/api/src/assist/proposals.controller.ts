import type { ProposalApproveResult, ProposalDetail, ProposalList } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  BrandParamDto,
  ProposalApproveRequestDto,
  ProposalApproveResultDto,
  ProposalDetailDto,
  ProposalListDto,
  ProposalListQueryDto,
  ProposalParamDto,
  ProposalRejectRequestDto,
} from './dto.js';
import { ProposalsService } from './proposals.service.js';

/**
 * Help center › Proposals (M7-05, `Admin/HelpCenter-ArticleApproval`):
 * articles drafted from tickets, waiting for a Team Leader. `help_center:manage`
 * (Admin and Team Leader); row-level security narrows a Team Leader to the
 * departments they lead, because a proposal follows its ticket's department.
 */
@Controller('api/brands/:brandId/help-center/proposals')
export class ProposalsController {
  readonly #proposals: ProposalsService;

  constructor(@Inject(ProposalsService) proposals: ProposalsService) {
    this.#proposals = proposals;
  }

  @Get()
  @Requires('help_center:manage')
  @ZodSerializerDto(ProposalListDto)
  list(
    @Param(new ZodValidationPipe(BrandParamDto)) _param: BrandParamDto,
    @Query(new ZodValidationPipe(ProposalListQueryDto)) query: ProposalListQueryDto,
  ): Promise<ProposalList> {
    return this.#proposals.list(getTx(), query);
  }

  @Get(':proposalId')
  @Requires('help_center:manage')
  @ZodSerializerDto(ProposalDetailDto)
  get(
    @Param(new ZodValidationPipe(ProposalParamDto)) { proposalId }: ProposalParamDto,
  ): Promise<ProposalDetail> {
    return this.#proposals.get(getTx(), proposalId);
  }

  @Post(':proposalId/approve')
  @HttpCode(HttpStatus.OK)
  @Requires('help_center:manage')
  @ZodSerializerDto(ProposalApproveResultDto)
  approve(
    @Param(new ZodValidationPipe(ProposalParamDto)) { brandId, proposalId }: ProposalParamDto,
    @Body(new ZodValidationPipe(ProposalApproveRequestDto)) body: ProposalApproveRequestDto,
  ): Promise<ProposalApproveResult> {
    return this.#proposals.approve(this.#context(brandId), proposalId, body);
  }

  @Post(':proposalId/reject')
  @HttpCode(HttpStatus.OK)
  @Requires('help_center:manage')
  @ZodSerializerDto(ProposalDetailDto)
  reject(
    @Param(new ZodValidationPipe(ProposalParamDto)) { brandId, proposalId }: ProposalParamDto,
    @Body(new ZodValidationPipe(ProposalRejectRequestDto)) body: ProposalRejectRequestDto,
  ): Promise<ProposalDetail> {
    return this.#proposals.reject(this.#context(brandId), proposalId, body);
  }

  #context(brandId: string) {
    return {
      tx: getTx(),
      brandId,
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
    };
  }
}

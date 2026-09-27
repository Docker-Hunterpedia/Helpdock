import type { BrandSettings, SlaPolicy, SlaPolicyList } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx } from '../context/request-context.js';
import {
  SlaBrandParamDto,
  SlaBrandSettingsDto,
  SlaPolicyCreateRequestDto,
  SlaPolicyDto,
  SlaPolicyListDto,
  SlaPolicyParamDto,
  SlaPolicyReorderRequestDto,
  SlaPolicyUpdateRequestDto,
  SlaSettingsUpdateRequestDto,
} from './dto.js';
import { slaAdminContext } from './sla-admin-context.js';
import { SlaPoliciesService } from './sla-policies.service.js';

/**
 * The SLAs tab of `Admin/Ticketing` (M3-02, artboard `Admin/Ticketing-SLAs`).
 * `ticketing:manage` for the reason `BusinessHoursController` gives; which
 * policies a Team Leader may touch is `sla-scope.ts`'s.
 */
@Controller('api/brands/:brandId')
export class SlaPoliciesController {
  readonly #policies: SlaPoliciesService;

  constructor(@Inject(SlaPoliciesService) policies: SlaPoliciesService) {
    this.#policies = policies;
  }

  @Get('sla-policies')
  @Requires('ticketing:manage')
  @ZodSerializerDto(SlaPolicyListDto)
  list(
    @Param(new ZodValidationPipe(SlaBrandParamDto)) _params: SlaBrandParamDto,
  ): Promise<SlaPolicyList> {
    return this.#policies.list(getTx());
  }

  @Post('sla-policies')
  @Requires('ticketing:manage')
  @ZodSerializerDto(SlaPolicyDto)
  create(
    @Param(new ZodValidationPipe(SlaBrandParamDto)) _params: SlaBrandParamDto,
    @Body(new ZodValidationPipe(SlaPolicyCreateRequestDto)) body: SlaPolicyCreateRequestDto,
  ): Promise<SlaPolicy> {
    return this.#policies.create(slaAdminContext(), body);
  }

  /** Declared before `:policyId`, so `reorder` is never read as a policy id. */
  @Post('sla-policies/reorder')
  @Requires('ticketing:manage')
  @ZodSerializerDto(SlaPolicyListDto)
  reorder(
    @Param(new ZodValidationPipe(SlaBrandParamDto)) _params: SlaBrandParamDto,
    @Body(new ZodValidationPipe(SlaPolicyReorderRequestDto)) body: SlaPolicyReorderRequestDto,
  ): Promise<SlaPolicyList> {
    return this.#policies.reorder(slaAdminContext(), body);
  }

  @Put('sla-policies/:policyId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(SlaPolicyDto)
  update(
    @Param(new ZodValidationPipe(SlaPolicyParamDto)) { policyId }: SlaPolicyParamDto,
    @Body(new ZodValidationPipe(SlaPolicyUpdateRequestDto)) body: SlaPolicyUpdateRequestDto,
  ): Promise<SlaPolicy> {
    return this.#policies.update(slaAdminContext(), policyId, body);
  }

  @Delete('sla-policies/:policyId')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(SlaPolicyParamDto)) { policyId }: SlaPolicyParamDto,
  ): Promise<void> {
    await this.#policies.remove(slaAdminContext(), policyId);
  }

  /** "For every policy": the AI toggle and "count reopens". */
  @Patch('ticketing/sla-settings')
  @Requires('ticketing:manage')
  @ZodSerializerDto(SlaBrandSettingsDto)
  settings(
    @Param(new ZodValidationPipe(SlaBrandParamDto)) _params: SlaBrandParamDto,
    @Body(new ZodValidationPipe(SlaSettingsUpdateRequestDto)) body: SlaSettingsUpdateRequestDto,
  ): Promise<BrandSettings> {
    return this.#policies.updateSettings(slaAdminContext(), body);
  }
}

import type { BrandAiCallsPage, BrandAiSettings, TicketAiCalls } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { BrandAiService } from './brand-ai.service.js';
import {
  AiBrandParamDto,
  BrandAiCallsPageDto,
  BrandAiCallsQueryDto,
  BrandAiModesUpdateDto,
  BrandAiPromptUpdateDto,
  BrandAiSettingsDto,
  BrandAiSettingsUpdateDto,
  TicketAiCallsDto,
  TicketAiCallsParamDto,
} from './dto.js';

/**
 * A brand's AI assistant (M7-01, M7-08; screen in M7-10 from the
 * `Admin/AI-Assistant` artboard), and the AI log on a ticket.
 *
 * Reading the settings and the brand's AI activity, and editing the system
 * prompt, are `ai:manage` — the Admin's and the Team Leader's (REQUIREMENTS
 * §4.7). The model, guardrails, budget and modes are `brand:manage`, the
 * Admin's alone.
 */
@Controller('api/brands/:brandId')
export class BrandAiController {
  readonly #ai: BrandAiService;

  constructor(@Inject(BrandAiService) ai: BrandAiService) {
    this.#ai = ai;
  }

  @Get('ai/settings')
  @Requires('ai:manage')
  @ZodSerializerDto(BrandAiSettingsDto)
  view(
    @Param(new ZodValidationPipe(AiBrandParamDto)) { brandId }: AiBrandParamDto,
  ): Promise<BrandAiSettings> {
    return this.#ai.view(getTx(), brandId);
  }

  @Put('ai/settings')
  @Requires('brand:manage')
  @ZodSerializerDto(BrandAiSettingsDto)
  update(
    @Param(new ZodValidationPipe(AiBrandParamDto)) { brandId }: AiBrandParamDto,
    @Body(new ZodValidationPipe(BrandAiSettingsUpdateDto)) body: BrandAiSettingsUpdateDto,
  ): Promise<BrandAiSettings> {
    return this.#ai.update(this.#context(brandId), body);
  }

  @Put('ai/modes')
  @Requires('brand:manage')
  @ZodSerializerDto(BrandAiSettingsDto)
  updateModes(
    @Param(new ZodValidationPipe(AiBrandParamDto)) { brandId }: AiBrandParamDto,
    @Body(new ZodValidationPipe(BrandAiModesUpdateDto)) body: BrandAiModesUpdateDto,
  ): Promise<BrandAiSettings> {
    return this.#ai.updateModes(this.#context(brandId), body);
  }

  @Get('ai/calls')
  @Requires('ai:manage')
  @ZodSerializerDto(BrandAiCallsPageDto)
  calls(
    @Param(new ZodValidationPipe(AiBrandParamDto)) { brandId }: AiBrandParamDto,
    @Query(new ZodValidationPipe(BrandAiCallsQueryDto)) query: BrandAiCallsQueryDto,
  ): Promise<BrandAiCallsPage> {
    return this.#ai.calls(getTx(), brandId, query);
  }

  @Put('ai/prompt')
  @Requires('ai:manage')
  @ZodSerializerDto(BrandAiSettingsDto)
  updatePrompt(
    @Param(new ZodValidationPipe(AiBrandParamDto)) { brandId }: AiBrandParamDto,
    @Body(new ZodValidationPipe(BrandAiPromptUpdateDto)) body: BrandAiPromptUpdateDto,
  ): Promise<BrandAiSettings> {
    return this.#ai.updatePrompt(this.#context(brandId), body);
  }

  @Get('tickets/:ticketId/ai-calls')
  @Requires('ticket:read')
  @ZodSerializerDto(TicketAiCallsDto)
  ticketCalls(
    @Param(new ZodValidationPipe(TicketAiCallsParamDto)) {
      brandId,
      ticketId,
    }: TicketAiCallsParamDto,
  ): Promise<TicketAiCalls> {
    return this.#ai.ticketCalls(getTx(), brandId, ticketId);
  }

  #context(brandId: string) {
    return {
      tx: getTx(),
      brandId,
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
    };
  }
}

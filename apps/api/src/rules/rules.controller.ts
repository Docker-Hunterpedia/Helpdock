import type {
  RuleBuilderOptions,
  RuleTestRunResult,
  WorkflowRule,
  WorkflowRuleList,
  WorkflowRunList,
} from '@helpdock/schemas';
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
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import {
  RuleBuilderOptionsDto,
  RuleCreateRequestDto,
  RuleListQueryDto,
  RuleParamDto,
  RuleReorderRequestDto,
  RuleRunQueryDto,
  RulesBrandParamDto,
  RuleTestRunRequestDto,
  RuleTestRunResultDto,
  RuleToggleRequestDto,
  RuleUpdateRequestDto,
  WorkflowRuleDto,
  WorkflowRuleListDto,
  WorkflowRunListDto,
} from './dto.js';
import { RulesService } from './rules.service.js';

/**
 * `Admin/Automation` (M3-03 to M3-05): the rule list and its order, the
 * builder, the execution log and the test run. Every route is
 * `ticketing:manage`; which of its holders may *change* a rule is narrowed in
 * the service, because a rule is brand-wide (`rules.service.ts`).
 *
 * Static paths are declared before `:ruleId`, so `runs`, `options` and
 * `test-run` can never be read as a rule id.
 */
@Controller('api/brands/:brandId/rules')
export class RulesController {
  readonly #rules: RulesService;

  constructor(@Inject(RulesService) rules: RulesService) {
    this.#rules = rules;
  }

  @Get()
  @Requires('ticketing:manage')
  @ZodSerializerDto(WorkflowRuleListDto)
  list(
    @Param(new ZodValidationPipe(RulesBrandParamDto)) _params: RulesBrandParamDto,
    @Query(new ZodValidationPipe(RuleListQueryDto)) query: RuleListQueryDto,
  ): Promise<WorkflowRuleList> {
    return this.#rules.list(requireTicketingContext(), query.kind);
  }

  @Post()
  @Requires('ticketing:manage')
  @ZodSerializerDto(WorkflowRuleDto)
  create(
    @Param(new ZodValidationPipe(RulesBrandParamDto)) _params: RulesBrandParamDto,
    @Body(new ZodValidationPipe(RuleCreateRequestDto)) body: RuleCreateRequestDto,
  ): Promise<WorkflowRule> {
    return this.#rules.create(requireTicketingContext(), body);
  }

  /** Every rule of one kind in its new order: the order rules for one event run in. */
  @Post('reorder')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(WorkflowRuleListDto)
  reorder(
    @Param(new ZodValidationPipe(RulesBrandParamDto)) _params: RulesBrandParamDto,
    @Body(new ZodValidationPipe(RuleReorderRequestDto)) body: RuleReorderRequestDto,
  ): Promise<WorkflowRuleList> {
    return this.#rules.reorder(requireTicketingContext(), body);
  }

  /** The execution log, newest first. */
  @Get('runs')
  @Requires('ticketing:manage')
  @ZodSerializerDto(WorkflowRunListDto)
  runs(
    @Param(new ZodValidationPipe(RulesBrandParamDto)) _params: RulesBrandParamDto,
    @Query(new ZodValidationPipe(RuleRunQueryDto)) query: RuleRunQueryDto,
  ): Promise<WorkflowRunList> {
    return this.#rules.runs(requireTicketingContext(), query);
  }

  /** What the builder's selects are filled from. */
  @Get('options')
  @Requires('ticketing:manage')
  @ZodSerializerDto(RuleBuilderOptionsDto)
  options(
    @Param(new ZodValidationPipe(RulesBrandParamDto)) _params: RulesBrandParamDto,
  ): Promise<RuleBuilderOptions> {
    return this.#rules.options(requireTicketingContext());
  }

  /** M3-05. A `POST` because it carries a draft, but it changes, sends and logs nothing. */
  @Post('test-run')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(RuleTestRunResultDto)
  testRun(
    @Param(new ZodValidationPipe(RulesBrandParamDto)) _params: RulesBrandParamDto,
    @Body(new ZodValidationPipe(RuleTestRunRequestDto)) body: RuleTestRunRequestDto,
  ): Promise<RuleTestRunResult> {
    return this.#rules.testRun(requireTicketingContext(), body);
  }

  @Put(':ruleId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(WorkflowRuleDto)
  update(
    @Param(new ZodValidationPipe(RuleParamDto)) { ruleId }: RuleParamDto,
    @Body(new ZodValidationPipe(RuleUpdateRequestDto)) body: RuleUpdateRequestDto,
  ): Promise<WorkflowRule> {
    return this.#rules.update(requireTicketingContext(), ruleId, body);
  }

  /** The list's switch. */
  @Patch(':ruleId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(WorkflowRuleDto)
  toggle(
    @Param(new ZodValidationPipe(RuleParamDto)) { ruleId }: RuleParamDto,
    @Body(new ZodValidationPipe(RuleToggleRequestDto)) body: RuleToggleRequestDto,
  ): Promise<WorkflowRule> {
    return this.#rules.setEnabled(requireTicketingContext(), ruleId, body.enabled);
  }

  @Delete(':ruleId')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(RuleParamDto)) { ruleId }: RuleParamDto,
  ): Promise<void> {
    await this.#rules.remove(requireTicketingContext(), ruleId);
  }
}

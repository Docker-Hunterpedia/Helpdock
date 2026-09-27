import {
  brandIdParamSchema,
  ruleBuilderOptionsSchema,
  ruleCreateRequestSchema,
  ruleListQuerySchema,
  ruleParamSchema,
  ruleReorderRequestSchema,
  ruleRunQuerySchema,
  ruleTestRunRequestSchema,
  ruleTestRunResultSchema,
  ruleToggleRequestSchema,
  ruleUpdateRequestSchema,
  workflowRuleListSchema,
  workflowRuleSchema,
  workflowRunListSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The rule schemas as Nest DTOs, declared here for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 */

export class WorkflowRuleDto extends createZodDto(workflowRuleSchema) {}
export class WorkflowRuleListDto extends createZodDto(workflowRuleListSchema) {}
export class WorkflowRunListDto extends createZodDto(workflowRunListSchema) {}
export class RuleBuilderOptionsDto extends createZodDto(ruleBuilderOptionsSchema) {}
export class RuleTestRunResultDto extends createZodDto(ruleTestRunResultSchema) {}

export class RuleCreateRequestDto extends createZodDto(ruleCreateRequestSchema) {}
export class RuleUpdateRequestDto extends createZodDto(ruleUpdateRequestSchema) {}
export class RuleToggleRequestDto extends createZodDto(ruleToggleRequestSchema) {}
export class RuleReorderRequestDto extends createZodDto(ruleReorderRequestSchema) {}
export class RuleTestRunRequestDto extends createZodDto(ruleTestRunRequestSchema) {}

export class RulesBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class RuleParamDto extends createZodDto(ruleParamSchema) {}
export class RuleListQueryDto extends createZodDto(ruleListQuerySchema) {}
export class RuleRunQueryDto extends createZodDto(ruleRunQuerySchema) {}

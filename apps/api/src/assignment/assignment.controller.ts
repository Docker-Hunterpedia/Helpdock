import type {
  AssignableAgentList,
  AssignmentAgent,
  AssignmentAgentList,
  DepartmentAssignment,
  DepartmentAssignmentList,
} from '@helpdock/schemas';
import {
  assignableAgentListSchema,
  assignmentAgentListSchema,
  assignmentAgentParamSchema,
  assignmentAgentSchema,
  assignmentAgentUpdateRequestSchema,
  assignmentDepartmentParamSchema,
  brandIdParamSchema,
  departmentAssignmentListSchema,
  departmentAssignmentSchema,
  departmentAssignmentUpdateRequestSchema,
} from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Patch } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import { AssignmentService } from './assignment.service.js';

class BrandParamDto extends createZodDto(brandIdParamSchema) {}
class DepartmentParamDto extends createZodDto(assignmentDepartmentParamSchema) {}
class AgentParamDto extends createZodDto(assignmentAgentParamSchema) {}
class DepartmentAssignmentDto extends createZodDto(departmentAssignmentSchema) {}
class DepartmentAssignmentListDto extends createZodDto(departmentAssignmentListSchema) {}
class DepartmentAssignmentUpdateDto extends createZodDto(departmentAssignmentUpdateRequestSchema) {}
class AssignmentAgentDto extends createZodDto(assignmentAgentSchema) {}
class AssignmentAgentListDto extends createZodDto(assignmentAgentListSchema) {}
class AssignmentAgentUpdateDto extends createZodDto(assignmentAgentUpdateRequestSchema) {}
class AssignableAgentListDto extends createZodDto(assignableAgentListSchema) {}

/**
 * M1-07's routes: the Assignment tab of `Admin/Ticketing`, and the read behind
 * the assignee picker.
 *
 * The tab is `ticketing:manage`, like every other tab of the screen; which
 * departments and which people a Team Leader may touch is the service's
 * question (`assignment.service.ts`). The picker is `ticket:write`, because
 * the person choosing an assignee is usually an Agent, who holds that and not
 * `staff:manage` — the gap PR #70 recorded in `screens/tickets/directory.ts`.
 */
@Controller('api/brands/:brandId/assignment')
export class AssignmentController {
  readonly #assignment: AssignmentService;

  constructor(@Inject(AssignmentService) assignment: AssignmentService) {
    this.#assignment = assignment;
  }

  @Get()
  @Requires('ticketing:manage')
  @ZodSerializerDto(DepartmentAssignmentListDto)
  list(
    @Param(new ZodValidationPipe(BrandParamDto)) _params: BrandParamDto,
  ): Promise<DepartmentAssignmentList> {
    return this.#assignment.list(requireTicketingContext());
  }

  @Patch(':departmentId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(DepartmentAssignmentDto)
  update(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { departmentId }: DepartmentParamDto,
    @Body(new ZodValidationPipe(DepartmentAssignmentUpdateDto)) body: DepartmentAssignmentUpdateDto,
  ): Promise<DepartmentAssignment> {
    return this.#assignment.update(requireTicketingContext(), departmentId, body);
  }

  @Get(':departmentId/agents')
  @Requires('ticketing:manage')
  @ZodSerializerDto(AssignmentAgentListDto)
  agents(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { departmentId }: DepartmentParamDto,
  ): Promise<AssignmentAgentList> {
    return this.#assignment.agents(requireTicketingContext(), departmentId);
  }

  @Patch(':departmentId/agents/:userId')
  @Requires('ticketing:manage')
  @ZodSerializerDto(AssignmentAgentDto)
  updateAgent(
    @Param(new ZodValidationPipe(AgentParamDto)) { departmentId, userId }: AgentParamDto,
    @Body(new ZodValidationPipe(AssignmentAgentUpdateDto)) body: AssignmentAgentUpdateDto,
  ): Promise<AssignmentAgent> {
    return this.#assignment.updateAgent(requireTicketingContext(), departmentId, userId, body);
  }

  @Get(':departmentId/assignable')
  @Requires('ticket:write')
  @ZodSerializerDto(AssignableAgentListDto)
  assignable(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { brandId, departmentId }: DepartmentParamDto,
  ): Promise<AssignableAgentList> {
    const { principal } = requireRequestContext();
    const role = principal?.type === 'staff' ? principal.brands[brandId]?.role : undefined;

    return this.#assignment.assignable(getTx(), brandId, role, departmentId);
  }
}

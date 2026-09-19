import type {
  DepartmentSummary,
  DepartmentSummaryList,
  EligibleMemberList,
  TeamList,
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
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import type { DepartmentActor } from './department-scope.js';
import { type DepartmentContext, DepartmentsService } from './departments.service.js';
import {
  BrandIdParamDto,
  DepartmentCreateRequestDto,
  DepartmentParamDto,
  DepartmentReorderRequestDto,
  DepartmentSummaryDto,
  DepartmentSummaryListDto,
  DepartmentUpdateRequestDto,
  EligibleMemberListDto,
  TeamCreateRequestDto,
  TeamListDto,
  TeamMemberAddRequestDto,
  TeamMemberParamDto,
  TeamParamDto,
  TeamUpdateRequestDto,
} from './dto.js';

/**
 * The Departments tab of `Admin/Ticketing`, and the department list every other
 * screen reads.
 *
 * **Two permissions, because DOMAIN-RULES §1.2 draws two lines.** Which
 * departments a brand *has* — creating, deleting, reordering — is
 * `brand:manage`, which only an Admin holds. What is *inside* one — its name,
 * its default team, its teams and their members — is `staff:manage`, which a
 * Team Leader holds too, and `department-scope.ts` then narrows it to the
 * departments they actually lead. Reading is `brand:read`, because an Agent's
 * chip picker is the same list.
 *
 * The brand comes from the `:brandId` path parameter, so the permission is
 * checked in that brand and the transaction names only that brand
 * (ARCHITECTURE §6). Nothing in this file filters by brand itself: the
 * row-level security policies do it, and a filter written by hand is a filter
 * that can be forgotten.
 *
 * **Every parameter names its schema**, for the reason `StaffController`'s
 * comment gives.
 */
@Controller('api/brands/:brandId/departments')
export class DepartmentsController {
  readonly #departments: DepartmentsService;

  constructor(@Inject(DepartmentsService) departments: DepartmentsService) {
    this.#departments = departments;
  }

  @Get()
  @Requires('brand:read')
  @ZodSerializerDto(DepartmentSummaryListDto)
  list(
    @Param(new ZodValidationPipe(BrandIdParamDto)) _params: BrandIdParamDto,
  ): Promise<DepartmentSummaryList> {
    return this.#departments.list(getTx());
  }

  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(DepartmentSummaryDto)
  create(
    @Body(new ZodValidationPipe(DepartmentCreateRequestDto)) body: DepartmentCreateRequestDto,
  ): Promise<DepartmentSummary> {
    return this.#departments.create(this.#context(), body);
  }

  /**
   * The whole list in its new order, which is what the drag handle and the
   * "Move up" / "Move down" row actions both send. `brand:manage`: the order is
   * the brand's, not one department's.
   */
  @Post('reorder')
  @Requires('brand:manage')
  @ZodSerializerDto(DepartmentSummaryListDto)
  reorder(
    @Body(new ZodValidationPipe(DepartmentReorderRequestDto)) body: DepartmentReorderRequestDto,
  ): Promise<DepartmentSummaryList> {
    return this.#departments.reorder(this.#context(), body);
  }

  @Patch(':departmentId')
  @Requires('staff:manage')
  @ZodSerializerDto(DepartmentSummaryDto)
  update(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { departmentId }: DepartmentParamDto,
    @Body(new ZodValidationPipe(DepartmentUpdateRequestDto)) body: DepartmentUpdateRequestDto,
  ): Promise<DepartmentSummary> {
    return this.#departments.update(this.#context(), departmentId, body);
  }

  @Delete(':departmentId')
  @Requires('brand:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { departmentId }: DepartmentParamDto,
  ): Promise<void> {
    await this.#departments.remove(this.#context(), departmentId);
  }

  // ------------------------------------------------------------------
  // Teams
  // ------------------------------------------------------------------

  @Get(':departmentId/teams')
  @Requires('brand:read')
  @ZodSerializerDto(TeamListDto)
  teams(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { departmentId }: DepartmentParamDto,
  ): Promise<TeamList> {
    return this.#departments.teams(getTx(), departmentId);
  }

  /**
   * Who may be put on a team here. It is `staff:manage` rather than
   * `brand:read` because it is the picker of an editing screen and it answers
   * with addresses: an Agent has no use for it and no business reading it. It
   * carries the actor for the same reason every write here does — a Team Leader
   * runs the picker of a department they lead, and no other.
   */
  @Get(':departmentId/eligible-members')
  @Requires('staff:manage')
  @ZodSerializerDto(EligibleMemberListDto)
  eligibleMembers(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { departmentId }: DepartmentParamDto,
  ): Promise<EligibleMemberList> {
    return this.#departments.eligibleMembers(this.#context(), departmentId);
  }

  @Post(':departmentId/teams')
  @Requires('staff:manage')
  @ZodSerializerDto(TeamListDto)
  createTeam(
    @Param(new ZodValidationPipe(DepartmentParamDto)) { departmentId }: DepartmentParamDto,
    @Body(new ZodValidationPipe(TeamCreateRequestDto)) body: TeamCreateRequestDto,
  ): Promise<TeamList> {
    return this.#departments.createTeam(this.#context(), departmentId, body);
  }

  @Patch(':departmentId/teams/:teamId')
  @Requires('staff:manage')
  @ZodSerializerDto(TeamListDto)
  renameTeam(
    @Param(new ZodValidationPipe(TeamParamDto)) { departmentId, teamId }: TeamParamDto,
    @Body(new ZodValidationPipe(TeamUpdateRequestDto)) body: TeamUpdateRequestDto,
  ): Promise<TeamList> {
    return this.#departments.renameTeam(this.#context(), { departmentId, teamId }, body);
  }

  @Delete(':departmentId/teams/:teamId')
  @Requires('staff:manage')
  @ZodSerializerDto(TeamListDto)
  deleteTeam(
    @Param(new ZodValidationPipe(TeamParamDto)) { departmentId, teamId }: TeamParamDto,
  ): Promise<TeamList> {
    return this.#departments.deleteTeam(this.#context(), { departmentId, teamId });
  }

  @Post(':departmentId/teams/:teamId/members')
  @Requires('staff:manage')
  @ZodSerializerDto(TeamListDto)
  addMember(
    @Param(new ZodValidationPipe(TeamParamDto)) { departmentId, teamId }: TeamParamDto,
    @Body(new ZodValidationPipe(TeamMemberAddRequestDto)) body: TeamMemberAddRequestDto,
  ): Promise<TeamList> {
    return this.#departments.addMember(this.#context(), { departmentId, teamId }, body.userId);
  }

  @Delete(':departmentId/teams/:teamId/members/:userId')
  @Requires('staff:manage')
  @ZodSerializerDto(TeamListDto)
  removeMember(
    @Param(new ZodValidationPipe(TeamMemberParamDto))
    { departmentId, teamId, userId }: TeamMemberParamDto,
  ): Promise<TeamList> {
    return this.#departments.removeMember(this.#context(), { departmentId, teamId }, userId);
  }

  // ------------------------------------------------------------------

  /**
   * The actor, built from the principal the guard resolved rather than from a
   * fresh read: the claims are what the permission was checked against, and a
   * second source would be a second answer to "who is asking?".
   */
  #context(): DepartmentContext {
    const request = requireRequestContext();
    const principal = request.principal;
    const brandId = request.targetBrandId;

    /* c8 ignore next 6 -- the permission guard has already refused anything else. */
    if (principal === null || principal.type !== 'staff' || brandId === null) {
      throw new Error('A ticketing route ran without a staff principal in a brand');
    }

    const membership = principal.brands[brandId];
    /* c8 ignore next 3 -- these permissions are only held through a membership. */
    if (membership === undefined) {
      throw new Error('A ticketing route ran without a membership in its target brand');
    }

    const actor: DepartmentActor = {
      userId: principal.id,
      role: membership.role,
      departmentIds: membership.departmentIds,
    };

    return { tx: getTx(), brandId, actor };
  }
}

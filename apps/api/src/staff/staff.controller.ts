import type { Brand } from '@helpdock/db';
import { brands } from '@helpdock/db';
import type { DepartmentList, StaffList, StaffMember } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  BrandStaffParamDto,
  DepartmentListDto,
  StaffInviteRequestDto,
  StaffListDto,
  StaffMemberDto,
  StaffSearchQueryDto,
  StaffUpdateRequestDto,
} from './dto.js';
import { type StaffContext, StaffService } from './staff.service.js';
import type { StaffActor } from './staff-scope.js';

/**
 * Staff and roles for one brand. Every route is `@Requires('staff:manage')`,
 * which an Admin and a Team Leader hold and nobody else does; what a Team
 * Leader may then do with it is `staff-scope.ts`.
 *
 * The brand comes from the `:brandId` path parameter, so the permission is
 * checked in that brand and the transaction names only that brand
 * (ARCHITECTURE §6). Nothing in this file filters by brand itself: the
 * row-level security policies do it, and a filter written by hand is a filter
 * that can be forgotten.
 *
 * **Every parameter names its schema**, as `AuthController` does and for the
 * reason its comment gives: the global pipe finds a DTO through
 * `design:paramtypes`, which a build that drops decorator metadata does not
 * emit, and a linter that rewrites an import to `import type` erases the class
 * the metadata would have named. Naming the pipe at the call site is the same
 * validation, decided where it can be read.
 */
@Controller('api/brands/:brandId')
export class StaffController {
  readonly #staff: StaffService;

  constructor(@Inject(StaffService) staff: StaffService) {
    this.#staff = staff;
  }

  @Get('departments')
  @Requires('brand:read')
  @ZodSerializerDto(DepartmentListDto)
  departments(): Promise<DepartmentList> {
    return this.#staff.departments(getTx());
  }

  @Get('staff')
  @Requires('staff:manage')
  @ZodSerializerDto(StaffListDto)
  list(
    @Query(new ZodValidationPipe(StaffSearchQueryDto)) query: StaffSearchQueryDto,
  ): Promise<StaffList> {
    return this.#staff.list(this.#context(), query.search);
  }

  @Post('staff/invites')
  @Requires('staff:manage')
  @ZodSerializerDto(StaffMemberDto)
  async invite(
    @Body(new ZodValidationPipe(StaffInviteRequestDto)) body: StaffInviteRequestDto,
  ): Promise<StaffMember> {
    const context = this.#context();

    return this.#staff.invite(context, await this.#brand(context), body);
  }

  @Post('staff/invites/:userId/resend')
  @Requires('staff:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resend(
    @Param(new ZodValidationPipe(BrandStaffParamDto)) { userId }: BrandStaffParamDto,
  ): Promise<void> {
    const context = this.#context();

    await this.#staff.resendInvite(context, await this.#brand(context), userId);
  }

  @Delete('staff/invites/:userId')
  @Requires('staff:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param(new ZodValidationPipe(BrandStaffParamDto)) { userId }: BrandStaffParamDto,
  ): Promise<void> {
    await this.#staff.revokeInvite(this.#context(), userId);
  }

  @Patch('staff/:userId')
  @Requires('staff:manage')
  @ZodSerializerDto(StaffMemberDto)
  update(
    @Param(new ZodValidationPipe(BrandStaffParamDto)) { userId }: BrandStaffParamDto,
    @Body(new ZodValidationPipe(StaffUpdateRequestDto)) body: StaffUpdateRequestDto,
  ): Promise<StaffMember> {
    return this.#staff.update(this.#context(), userId, body);
  }

  @Post('staff/:userId/deactivate')
  @Requires('staff:manage')
  @ZodSerializerDto(StaffMemberDto)
  deactivate(
    @Param(new ZodValidationPipe(BrandStaffParamDto)) { userId }: BrandStaffParamDto,
  ): Promise<StaffMember> {
    return this.#staff.setActivation(this.#context(), userId, false);
  }

  @Post('staff/:userId/reactivate')
  @Requires('staff:manage')
  @ZodSerializerDto(StaffMemberDto)
  reactivate(
    @Param(new ZodValidationPipe(BrandStaffParamDto)) { userId }: BrandStaffParamDto,
  ): Promise<StaffMember> {
    return this.#staff.setActivation(this.#context(), userId, true);
  }

  /** The role in this brand, not the account. DOMAIN-RULES §12's last row. */
  @Delete('staff/:userId/role')
  @Requires('staff:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(BrandStaffParamDto)) { userId }: BrandStaffParamDto,
  ): Promise<void> {
    await this.#staff.removeFromBrand(this.#context(), userId);
  }

  // ------------------------------------------------------------------

  /**
   * The actor, built from the principal the guard resolved rather than from a
   * fresh read: the claims are what the permission was checked against, and a
   * second source would be a second answer to "who is asking?".
   */
  #context(): StaffContext {
    const request = requireRequestContext();
    const principal = request.principal;
    const brandId = request.targetBrandId;

    /* c8 ignore next 6 -- the permission guard has already refused anything else. */
    if (principal === null || principal.type !== 'staff' || brandId === null) {
      throw new Error('A staff route ran without a staff principal in a brand');
    }

    const membership = principal.brands[brandId];
    /* c8 ignore next 3 -- `staff:manage` is only held through a membership. */
    if (membership === undefined) {
      throw new Error('A staff route ran without a membership in its target brand');
    }

    const actor: StaffActor = {
      userId: principal.id,
      role: membership.role,
      departmentIds: membership.departmentIds,
      installAdmin: principal.installAdmin,
    };

    return { tx: getTx(), brandId, actor };
  }

  /** The brand's own row, for the name the invitation email carries. */
  async #brand(context: StaffContext): Promise<Brand> {
    const rows = await context.tx
      .select()
      .from(brands)
      .where(eq(brands.id, context.brandId))
      .limit(1);

    const brand = rows[0];
    if (brand === undefined) {
      throw new NotFoundException('No such brand');
    }

    return brand;
  }
}

import type { SecondFactorReset, SecondFactorSummary } from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import {
  SecondFactorResetDto,
  SecondFactorResetRequestDto,
  SecondFactorSummaryDto,
  StaffUserIdParamDto,
} from './dto.js';
import { InstallStaffService } from './install-staff.service.js';
import { SecondFactorResetService } from './second-factor-reset.service.js';

/**
 * The staff routes that are not about one brand, and therefore run in install
 * scope — audited on entry by the tenant interceptor, like every other install
 * path: deleting an account for good, and resetting another person's second
 * factor (#398).
 */
@Controller('api/install/staff')
export class InstallStaffController {
  readonly #staff: InstallStaffService;
  readonly #reset: SecondFactorResetService;

  constructor(
    @Inject(InstallStaffService) staff: InstallStaffService,
    @Inject(SecondFactorResetService) reset: SecondFactorResetService,
  ) {
    this.#staff = staff;
    this.#reset = reset;
  }

  /** What a reset would remove, with the digest the reset has to carry back. */
  @Get(':userId/second-factor')
  @Requires('install:admin')
  @ZodSerializerDto(SecondFactorSummaryDto)
  secondFactor(
    @Param(new ZodValidationPipe(StaffUserIdParamDto)) { userId }: StaffUserIdParamDto,
  ): Promise<SecondFactorSummary> {
    return this.#reset.summary(getTx(), this.#actorId(), userId);
  }

  /** Removes the person's app, passkeys and recovery codes and signs them out everywhere. */
  @Post(':userId/second-factor/reset')
  @Requires('install:admin')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(SecondFactorResetDto)
  resetSecondFactor(
    @Param(new ZodValidationPipe(StaffUserIdParamDto)) { userId }: StaffUserIdParamDto,
    @Body(new ZodValidationPipe(SecondFactorResetRequestDto)) body: SecondFactorResetRequestDto,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<SecondFactorReset> {
    return this.#reset.reset({
      tx: getTx(),
      actorId: this.#actorId(),
      targetId: userId,
      authorization,
      request: body,
    });
  }

  @Delete(':userId')
  @Requires('install:admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param(new ZodValidationPipe(StaffUserIdParamDto)) { userId }: StaffUserIdParamDto,
  ): Promise<void> {
    await this.#staff.delete(getTx(), this.#actorId(), userId);
  }

  #actorId(): string {
    return requireStaffPrincipalId(requireRequestContext().principal);
  }
}

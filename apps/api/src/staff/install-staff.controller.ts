import { Controller, Delete, HttpCode, HttpStatus, Inject, Param } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { StaffUserIdParamDto } from './dto.js';
import { InstallStaffService } from './install-staff.service.js';

/**
 * Deleting an account for good. The only staff route that is not about one
 * brand, and therefore the only one that runs in install scope — audited on
 * entry by the tenant interceptor, like every other install path.
 */
@Controller('api/install/staff')
export class InstallStaffController {
  readonly #staff: InstallStaffService;

  constructor(@Inject(InstallStaffService) staff: InstallStaffService) {
    this.#staff = staff;
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

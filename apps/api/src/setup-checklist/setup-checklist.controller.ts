import type { SetupChecklist } from '@helpdock/schemas';
import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { SetupChecklistDto, SetupChecklistParamDto } from './dto.js';
import { type SetupChecklistContext, SetupChecklistService } from './setup-checklist.service.js';

/**
 * The "Get set up" checklist of the sidebar (M14-13, `Admin/SetupChecklist`).
 * Both routes are `brand:manage`: an Admin's, and nobody else's (D-31).
 */
@Controller('api/brands/:brandId/setup-checklist')
export class SetupChecklistController {
  readonly #checklist: SetupChecklistService;

  constructor(@Inject(SetupChecklistService) checklist: SetupChecklistService) {
    this.#checklist = checklist;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(SetupChecklistDto)
  view(
    @Param(new ZodValidationPipe(SetupChecklistParamDto)) { brandId }: SetupChecklistParamDto,
  ): Promise<SetupChecklist> {
    return this.#checklist.view(this.#context(brandId));
  }

  /** Hides the checklist for the caller in this brand; it answers with the checklist as it now reads. */
  @Post('dismiss')
  @HttpCode(HttpStatus.OK)
  @Requires('brand:manage')
  @ZodSerializerDto(SetupChecklistDto)
  dismiss(
    @Param(new ZodValidationPipe(SetupChecklistParamDto)) { brandId }: SetupChecklistParamDto,
  ): Promise<SetupChecklist> {
    return this.#checklist.dismiss(this.#context(brandId));
  }

  #context(brandId: string): SetupChecklistContext {
    return {
      tx: getTx(),
      brandId,
      userId: requireStaffPrincipalId(requireRequestContext().principal),
    };
  }
}

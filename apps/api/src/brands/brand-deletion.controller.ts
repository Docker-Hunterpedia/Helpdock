import {
  type BrandDeletion,
  brandDeletionRequestSchema,
  brandDeletionSchema,
  installBrandParamSchema,
} from '@helpdock/schemas';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { BrandDeletionService } from './brand-deletion.service.js';

class InstallBrandParamDto extends createZodDto(installBrandParamSchema) {}
class BrandDeletionRequestDto extends createZodDto(brandDeletionRequestSchema) {}
class BrandDeletionDto extends createZodDto(brandDeletionSchema) {}

/**
 * Brand deletion (M8-07, DOMAIN-RULES §11). Install admin only: a brand is
 * the tenant boundary, and deleting one removes every person's work in it.
 * Each route runs in install scope and is audited on entry by the tenant
 * interceptor, and the service writes its own row besides.
 */
@Controller('api/install/brands/:id/deletion')
export class BrandDeletionController {
  readonly #deletion: BrandDeletionService;

  constructor(@Inject(BrandDeletionService) deletion: BrandDeletionService) {
    this.#deletion = deletion;
  }

  @Get()
  @Requires('install:admin')
  @ZodSerializerDto(BrandDeletionDto)
  status(
    @Param(new ZodValidationPipe(InstallBrandParamDto)) { id }: InstallBrandParamDto,
  ): Promise<BrandDeletion> {
    return this.#deletion.status(getTx(), id);
  }

  /** Starts the 30-day grace. The brand answers 410 everywhere public from now on. */
  @Post()
  @HttpCode(200)
  @Requires('install:admin')
  @ZodSerializerDto(BrandDeletionDto)
  request(
    @Param(new ZodValidationPipe(InstallBrandParamDto)) { id }: InstallBrandParamDto,
    @Body(new ZodValidationPipe(BrandDeletionRequestDto)) body: BrandDeletionRequestDto,
  ): Promise<BrandDeletion> {
    return this.#deletion.request({
      tx: getTx(),
      brandId: id,
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
      confirmPrefix: body.confirmPrefix,
    });
  }

  /** Restores the brand, while the grace lasts. */
  @Delete()
  @Requires('install:admin')
  @ZodSerializerDto(BrandDeletionDto)
  cancel(
    @Param(new ZodValidationPipe(InstallBrandParamDto)) { id }: InstallBrandParamDto,
  ): Promise<BrandDeletion> {
    return this.#deletion.cancel({
      tx: getTx(),
      brandId: id,
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
    });
  }
}

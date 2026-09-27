import type { WebFormSettings } from '@helpdock/schemas';
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { WebFormBrandParamDto, WebFormSettingsDto, WebFormSettingsUpdateDto } from './dto.js';
import { WebFormSettingsService } from './web-form-settings.service.js';

/**
 * Channels › Web form (M4-09, artboard `AdminWebForm`). `brand:manage`, as
 * the other channel tabs an Admin configures: the form decides which
 * department strangers' tickets are filed in.
 */
@Controller('api/brands/:brandId/web-form')
export class WebFormSettingsController {
  readonly #settings: WebFormSettingsService;

  constructor(@Inject(WebFormSettingsService) settings: WebFormSettingsService) {
    this.#settings = settings;
  }

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(WebFormSettingsDto)
  read(
    @Param(new ZodValidationPipe(WebFormBrandParamDto)) { brandId }: WebFormBrandParamDto,
  ): Promise<WebFormSettings> {
    return this.#settings.read(getTx(), brandId);
  }

  @Put()
  @Requires('brand:manage')
  @ZodSerializerDto(WebFormSettingsDto)
  save(
    @Param(new ZodValidationPipe(WebFormBrandParamDto)) { brandId }: WebFormBrandParamDto,
    @Body(new ZodValidationPipe(WebFormSettingsUpdateDto)) body: WebFormSettingsUpdateDto,
  ): Promise<WebFormSettings> {
    return this.#settings.save(
      {
        tx: getTx(),
        brandId,
        actorId: requireStaffPrincipalId(requireRequestContext().principal),
      },
      body,
    );
  }
}

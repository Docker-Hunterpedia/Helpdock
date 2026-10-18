import {
  importBrandParamSchema,
  importFilePresetCreateSchema,
  importFilePresetDeleteSchema,
  importFilePresetListQuerySchema,
  importFilePresetListSchema,
  importFilePresetParamSchema,
  importFilePresetViewSchema,
} from '@helpdock/schemas';
import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import { ImportFilePresetsService } from './file-presets.service.js';

class BrandParamDto extends createZodDto(importBrandParamSchema) {}
class PresetParamDto extends createZodDto(importFilePresetParamSchema) {}
class PresetCreateDto extends createZodDto(importFilePresetCreateSchema) {}
class PresetQueryDto extends createZodDto(importFilePresetListQuerySchema) {}
class PresetListDto extends createZodDto(importFilePresetListSchema) {}
class PresetViewDto extends createZodDto(importFilePresetViewSchema) {}
class PresetDeleteDto extends createZodDto(importFilePresetDeleteSchema) {}

@Controller('api/brands/:brandId/import-presets')
export class ImportFilePresetsController {
  constructor(@Inject(ImportFilePresetsService) readonly presets: ImportFilePresetsService) {}

  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(PresetListDto)
  list(
    @Param(new ZodValidationPipe(BrandParamDto)) _params: BrandParamDto,
    @Query(new ZodValidationPipe(PresetQueryDto)) query: PresetQueryDto,
  ) {
    return this.presets.list(requireTicketingContext(), query);
  }

  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(PresetViewDto)
  create(
    @Param(new ZodValidationPipe(BrandParamDto)) _params: BrandParamDto,
    @Body(new ZodValidationPipe(PresetCreateDto)) input: PresetCreateDto,
  ) {
    return this.presets.create(requireTicketingContext(), input);
  }

  @Delete(':presetId')
  @Requires('brand:manage')
  @ZodSerializerDto(PresetDeleteDto)
  delete(@Param(new ZodValidationPipe(PresetParamDto)) { presetId }: PresetParamDto) {
    return this.presets.delete(requireTicketingContext(), presetId);
  }
}

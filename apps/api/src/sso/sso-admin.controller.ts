import type { SsoConnectionInput, SsoMapping, SsoSettingsUpdate } from '@helpdock/schemas';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import {
  SsoConnectionDto,
  SsoCreateDto,
  SsoDetailDto,
  SsoListDto,
  SsoMappingsDto,
  SsoParamDto,
  SsoSettingsDto,
  SsoSettingsUpdateDto,
  SsoUpdateDto,
} from './dto.js';
import { SsoService } from './sso.service.js';

@Controller('api/install/sso')
export class SsoAdminController {
  constructor(@Inject(SsoService) private readonly sso: SsoService) {}

  @Get('connections')
  @Requires('install:admin')
  @ZodSerializerDto(SsoListDto)
  list() {
    return this.sso.list();
  }

  @Post('connections')
  @Requires('install:admin')
  @ZodSerializerDto(SsoConnectionDto)
  create(@Body(new ZodValidationPipe(SsoCreateDto)) input: SsoConnectionInput) {
    return this.sso.create(input);
  }

  @Get('connections/:id')
  @Requires('install:admin')
  @ZodSerializerDto(SsoDetailDto)
  get(@Param(new ZodValidationPipe(SsoParamDto)) params: { id: string }) {
    return this.sso.get(params.id);
  }

  @Put('connections/:id')
  @Requires('install:admin')
  @ZodSerializerDto(SsoConnectionDto)
  update(
    @Param(new ZodValidationPipe(SsoParamDto)) params: { id: string },
    @Body(new ZodValidationPipe(SsoUpdateDto)) input: SsoConnectionInput,
  ) {
    return this.sso.update(params.id, input);
  }

  @Delete('connections/:id')
  @Requires('install:admin')
  @HttpCode(204)
  remove(@Param(new ZodValidationPipe(SsoParamDto)) params: { id: string }) {
    return this.sso.remove(params.id);
  }

  @Get('connections/:id/mappings')
  @Requires('install:admin')
  @ZodSerializerDto(SsoMappingsDto)
  mappings(@Param(new ZodValidationPipe(SsoParamDto)) params: { id: string }) {
    return this.sso.mappings(params.id);
  }

  @Put('connections/:id/mappings')
  @Requires('install:admin')
  @ZodSerializerDto(SsoMappingsDto)
  replaceMappings(
    @Param(new ZodValidationPipe(SsoParamDto)) params: { id: string },
    @Body(new ZodValidationPipe(SsoMappingsDto)) input: { mappings: SsoMapping[] },
  ) {
    return this.sso.replaceMappings(params.id, input.mappings);
  }

  @Get('settings')
  @Requires('install:admin')
  @ZodSerializerDto(SsoSettingsDto)
  settings() {
    return this.sso.settings();
  }

  @Put('settings')
  @Requires('install:admin')
  @ZodSerializerDto(SsoSettingsDto)
  saveSettings(@Body(new ZodValidationPipe(SsoSettingsUpdateDto)) input: SsoSettingsUpdate) {
    return this.sso.saveSettings(input);
  }
}

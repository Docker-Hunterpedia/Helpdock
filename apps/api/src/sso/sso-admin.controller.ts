import type {
  SsoConfiguration,
  SsoConnectionInput,
  SsoMapping,
  SsoSettingsUpdate,
} from '@helpdock/schemas';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { StepTransactions } from '../tenant/step-transactions.js';
import {
  SsoCertificateDetailsDto,
  SsoCertificatesDto,
  SsoConfigurationDto,
  SsoConnectionDto,
  SsoCreateDto,
  SsoDetailDto,
  SsoListDto,
  SsoMappingsDto,
  SsoParamDto,
  SsoSettingsDto,
  SsoSettingsUpdateDto,
  SsoTargetsDto,
  SsoTestKeyDto,
  SsoTestResultDto,
  SsoTestStartDto,
  SsoUpdateDto,
} from './dto.js';
import { SsoService } from './sso.service.js';
import { SsoTestSignInService } from './test-sign-in.service.js';

@Controller('api/install/sso')
export class SsoAdminController {
  constructor(
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(SsoTestSignInService) private readonly tests: SsoTestSignInService,
  ) {}

  @Post('certificates/inspect')
  @Requires('install:admin')
  @HttpCode(200)
  @ZodSerializerDto(SsoCertificateDetailsDto)
  inspectCertificates(@Body(new ZodValidationPipe(SsoCertificatesDto)) input: SsoCertificatesDto) {
    return this.sso.inspectCertificates(input.certificates);
  }

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

  @Post('configurations')
  @Requires('install:admin')
  @ZodSerializerDto(SsoConnectionDto)
  async createConfiguration(
    @Body(new ZodValidationPipe(SsoConfigurationDto)) input: SsoConfiguration,
  ) {
    const connection = await this.sso.create(input.connection);
    await this.sso.replaceMappings(connection.id, input.mappings);
    return connection;
  }

  @Put('connections/:id/configuration')
  @Requires('install:admin')
  @ZodSerializerDto(SsoConnectionDto)
  async updateConfiguration(
    @Param(new ZodValidationPipe(SsoParamDto)) params: { id: string },
    @Body(new ZodValidationPipe(SsoConfigurationDto)) input: SsoConfiguration,
  ) {
    const connection = await this.sso.update(params.id, input.connection);
    await this.sso.replaceMappings(connection.id, input.mappings);
    return connection;
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

  @Post('connections/:id/test')
  @Requires('install:admin')
  @ZodSerializerDto(SsoTestStartDto)
  test(@Param(new ZodValidationPipe(SsoParamDto)) params: { id: string }) {
    return this.tests.start(params.id);
  }

  @Get('connections/:id/test')
  @Requires('install:admin')
  @ZodSerializerDto(SsoTestResultDto)
  testResult(
    @Param(new ZodValidationPipe(SsoParamDto)) params: { id: string },
    @Query(new ZodValidationPipe(SsoTestKeyDto)) query: SsoTestKeyDto,
  ) {
    return this.tests.result(params.id, query.key);
  }

  @Get('targets')
  @StepTransactions()
  @Requires('install:admin')
  @ZodSerializerDto(SsoTargetsDto)
  targets() {
    return this.sso.targets();
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

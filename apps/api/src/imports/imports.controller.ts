import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import {
  ImportBrandParamDto,
  ImportConnectionRequestDto,
  ImportConnectionResultDto,
  ImportRunCreateDto,
  ImportRunListDto,
  ImportRunParamDto,
  ImportRunViewDto,
  ImportScopeDto,
} from './dto.js';
import { ImportsService } from './imports.service.js';

@Controller('api/brands/:brandId/imports')
export class ImportsController {
  constructor(@Inject(ImportsService) readonly imports: ImportsService) {}
  @Get()
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunListDto)
  list(@Param(new ZodValidationPipe(ImportBrandParamDto)) _params: ImportBrandParamDto) {
    return this.imports.list(requireTicketingContext());
  }
  @Post()
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  create(
    @Param(new ZodValidationPipe(ImportBrandParamDto)) _params: ImportBrandParamDto,
    @Body(new ZodValidationPipe(ImportRunCreateDto)) body: ImportRunCreateDto,
  ) {
    return this.imports.create(requireTicketingContext(), body);
  }
  @Get(':runId')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  get(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.get(requireTicketingContext(), runId);
  }
  @Put(':runId/connection')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportConnectionResultDto)
  connect(
    @Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto,
    @Body(new ZodValidationPipe(ImportConnectionRequestDto)) body: ImportConnectionRequestDto,
  ) {
    return this.imports.connect(requireTicketingContext(), runId, body);
  }
  @Post(':runId/extract')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  extract(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.extract(requireTicketingContext(), runId);
  }
  @Put(':runId/scope')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  scope(
    @Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto,
    @Body(new ZodValidationPipe(ImportScopeDto)) body: ImportScopeDto,
  ) {
    return this.imports.scope(requireTicketingContext(), runId, body);
  }
  @Post(':runId/pause')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  pause(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.control(requireTicketingContext(), runId, 'pause');
  }
  @Post(':runId/resume')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  resume(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.control(requireTicketingContext(), runId, 'resume');
  }
  @Post(':runId/cancel')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  cancel(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.control(requireTicketingContext(), runId, 'cancel');
  }
}

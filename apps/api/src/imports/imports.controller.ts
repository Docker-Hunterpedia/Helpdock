import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import {
  ImportBrandParamDto,
  ImportConnectionRequestDto,
  ImportConnectionResultDto,
  ImportContactPreviewDto,
  ImportContactPreviewQueryDto,
  ImportDryRunReportDto,
  ImportDryRunRequestDto,
  ImportMappingsRequestDto,
  ImportMappingsViewDto,
  ImportPreviewSamplesDto,
  ImportRunCreateDto,
  ImportRunListDto,
  ImportRunParamDto,
  ImportRunViewDto,
  ImportScopeDto,
  ImportStartRequestDto,
  ImportTicketPreviewDto,
  ImportTicketPreviewQueryDto,
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
  @Get(':runId/preview/ticket')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportTicketPreviewDto)
  previewTicket(
    @Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto,
    @Query(new ZodValidationPipe(ImportTicketPreviewQueryDto)) query: ImportTicketPreviewQueryDto,
  ) {
    return this.imports.previewTicket(requireTicketingContext(), runId, query);
  }
  @Get(':runId/preview/contact')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportContactPreviewDto)
  previewContact(
    @Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto,
    @Query(new ZodValidationPipe(ImportContactPreviewQueryDto)) query: ImportContactPreviewQueryDto,
  ) {
    return this.imports.previewContact(requireTicketingContext(), runId, query);
  }
  @Get(':runId/preview/samples')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportPreviewSamplesDto)
  previewSamples(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.previewSamples(requireTicketingContext(), runId);
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
  @Get(':runId/dry-run')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportDryRunReportDto)
  dryRunReport(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.dryRunReport(requireTicketingContext(), runId);
  }
  @Post(':runId/dry-run')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  dryRun(
    @Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto,
    @Body(new ZodValidationPipe(ImportDryRunRequestDto)) body: ImportDryRunRequestDto,
  ) {
    return this.imports.dryRun(requireTicketingContext(), runId, body);
  }
  @Post(':runId/start')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(ImportRunViewDto)
  start(
    @Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto,
    @Body(new ZodValidationPipe(ImportStartRequestDto)) body: ImportStartRequestDto,
  ) {
    return this.imports.start(requireTicketingContext(), runId, body);
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
  @Get(':runId/mappings')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportMappingsViewDto)
  mappings(@Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto) {
    return this.imports.mappings(requireTicketingContext(), runId);
  }
  @Put(':runId/mappings')
  @Requires('brand:manage')
  @ZodSerializerDto(ImportMappingsViewDto)
  confirmMappings(
    @Param(new ZodValidationPipe(ImportRunParamDto)) { runId }: ImportRunParamDto,
    @Body(new ZodValidationPipe(ImportMappingsRequestDto)) body: ImportMappingsRequestDto,
  ) {
    return this.imports.confirmMappings(requireTicketingContext(), runId, body);
  }
}

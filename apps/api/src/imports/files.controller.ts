import {
  type ImportFileUploadRequest,
  importFileDeleteSchema,
  importFileListSchema,
  importFileMappingRequestSchema,
  importFileParamSchema,
  importFileSourceRequestSchema,
  importFileUploadRequestSchema,
  importFileUploadResponseSchema,
  importFileViewSchema,
  importInventoryMappingRequestSchema,
  importRunParamSchema,
  importRunViewSchema,
} from '@helpdock/schemas';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import { ImportFilesService } from './files.service.js';

class RunParamDto extends createZodDto(importRunParamSchema) {}
class FileParamDto extends createZodDto(importFileParamSchema) {}
class FileSourceDto extends createZodDto(importFileSourceRequestSchema) {}
class RunViewDto extends createZodDto(importRunViewSchema) {}
const FileUploadDto = createZodDto(importFileUploadRequestSchema);
class FileUploadViewDto extends createZodDto(importFileUploadResponseSchema) {}
class FileListDto extends createZodDto(importFileListSchema) {}
class FileViewDto extends createZodDto(importFileViewSchema) {}
class FileMappingDto extends createZodDto(importFileMappingRequestSchema) {}
class FileDeleteDto extends createZodDto(importFileDeleteSchema) {}
class InventoryMappingDto extends createZodDto(importInventoryMappingRequestSchema) {}

@Controller('api/brands/:brandId/imports/:runId')
export class ImportFilesController {
  constructor(@Inject(ImportFilesService) readonly files: ImportFilesService) {}

  @Put('file-source')
  @Requires('brand:manage')
  @ZodSerializerDto(RunViewDto)
  connect(
    @Param(new ZodValidationPipe(RunParamDto)) { runId }: RunParamDto,
    @Body(new ZodValidationPipe(FileSourceDto)) input: FileSourceDto,
  ) {
    return this.files.connect(requireTicketingContext(), runId, input);
  }

  @Get('files')
  @Requires('brand:manage')
  @ZodSerializerDto(FileListDto)
  list(@Param(new ZodValidationPipe(RunParamDto)) { runId }: RunParamDto) {
    return this.files.list(requireTicketingContext(), runId);
  }

  @Post('files/presign')
  @Requires('brand:manage')
  @ZodSerializerDto(FileUploadViewDto)
  upload(
    @Param(new ZodValidationPipe(RunParamDto)) { runId }: RunParamDto,
    @Body(new ZodValidationPipe(FileUploadDto)) input: ImportFileUploadRequest,
  ) {
    return this.files.upload(requireTicketingContext(), runId, input);
  }

  @Get('files/:fileId')
  @Requires('brand:manage')
  @ZodSerializerDto(FileViewDto)
  get(@Param(new ZodValidationPipe(FileParamDto)) { runId, fileId }: FileParamDto) {
    return this.files.get(requireTicketingContext(), runId, fileId);
  }

  @Post('files/:fileId/confirm')
  @HttpCode(200)
  @Requires('brand:manage')
  @ZodSerializerDto(FileViewDto)
  confirm(@Param(new ZodValidationPipe(FileParamDto)) { runId, fileId }: FileParamDto) {
    return this.files.confirm(requireTicketingContext(), runId, fileId);
  }

  @Put('files/:fileId/mapping')
  @Requires('brand:manage')
  @ZodSerializerDto(FileViewDto)
  mapping(
    @Param(new ZodValidationPipe(FileParamDto)) { runId, fileId }: FileParamDto,
    @Body(new ZodValidationPipe(FileMappingDto)) input: FileMappingDto,
  ) {
    return this.files.mapping(requireTicketingContext(), runId, fileId, input.mapping);
  }

  @Delete('files/:fileId')
  @Requires('brand:manage')
  @ZodSerializerDto(FileDeleteDto)
  discard(@Param(new ZodValidationPipe(FileParamDto)) { runId, fileId }: FileParamDto) {
    return this.files.discard(requireTicketingContext(), runId, fileId);
  }

  @Put('files/:fileId/inventory-mapping')
  @Requires('brand:manage')
  @ZodSerializerDto(FileViewDto)
  inventoryMapping(
    @Param(new ZodValidationPipe(FileParamDto)) { runId, fileId }: FileParamDto,
    @Body(new ZodValidationPipe(InventoryMappingDto)) input: InventoryMappingDto,
  ) {
    return this.files.inventoryMapping(requireTicketingContext(), runId, fileId, input.mapping);
  }
}

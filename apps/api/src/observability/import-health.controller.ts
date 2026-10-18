import { importHealthPageSchema, importHealthQuerySchema } from '@helpdock/schemas';
import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { REDIS } from '../runtime/tokens.js';
import { readImportHealthPage } from './import-health.js';

class ImportHealthQueryDto extends createZodDto(importHealthQuerySchema) {}
const ImportHealthPageDto = createZodDto(importHealthPageSchema);

@Controller('api/install/system/imports')
export class ImportHealthController {
  constructor(@Inject(REDIS) readonly redis: Redis) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Requires('install:admin')
  @ZodSerializerDto(ImportHealthPageDto)
  list(@Query(new ZodValidationPipe(ImportHealthQueryDto)) query: ImportHealthQueryDto) {
    return readImportHealthPage(this.redis, query);
  }
}

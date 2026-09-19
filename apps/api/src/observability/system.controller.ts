import type { SystemQueuePage, SystemQueuesQuery, SystemStatus } from '@helpdock/schemas';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { SystemQueuePageDto, SystemQueuesQueryDto, SystemStatusDto } from '../routes/dto.js';
import { SystemService } from './system.service.js';

/**
 * The System page's data (REQUIREMENTS §4.10).
 *
 * `@Requires('install:admin')` rather than `'system:read'`: everything here is
 * install-wide — the schema, the queues, the runtime database role, the audit
 * log — and a brand's Admin has no business reading another brand's
 * infrastructure. The route therefore runs in install scope and the tenant
 * interceptor writes an `install.scope.access` audit row before the handler
 * sees the transaction (ARCHITECTURE §6).
 */
@Controller('api')
export class SystemController {
  readonly #system: SystemService;

  constructor(@Inject(SystemService) system: SystemService) {
    this.#system = system;
  }

  @Get('install/system')
  @Requires('install:admin')
  @ZodSerializerDto(SystemStatusDto)
  async status(): Promise<SystemStatus> {
    return this.#system.status();
  }

  /**
   * Every queue, paginated. The status read carries the first few so one
   * request draws the page; this is what "All queues" asks for.
   *
   * The pipe is constructed with the DTO rather than left to the global one.
   * The global pipe finds the schema through the parameter's *design-time
   * type*, which only exists if the DTO is imported as a value — and a
   * parameter that is otherwise used only as a type annotation is something the
   * formatter is free to rewrite to `import type`, silently erasing the class
   * and with it the validation. Naming the DTO here is a use that cannot be
   * erased (`apps/api/README.md`, "Adding a route").
   */
  @Get('install/system/queues')
  @Requires('install:admin')
  @ZodSerializerDto(SystemQueuePageDto)
  async queues(
    @Query(new ZodValidationPipe(SystemQueuesQueryDto)) query: SystemQueuesQuery,
  ): Promise<SystemQueuePage> {
    return this.#system.queuePage(query);
  }
}

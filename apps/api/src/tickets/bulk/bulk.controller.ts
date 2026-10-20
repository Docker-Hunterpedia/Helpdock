import type { BulkResponse, BulkUndoResponse } from '@helpdock/schemas';
import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import type { Principal } from '../../auth/principal.js';
import { Requires } from '../../auth/route-declaration.js';
import { requireRequestContext } from '../../context/request-context.js';
import {
  BulkOperationParamDto,
  BulkRequestDto,
  BulkResponseDto,
  BulkUndoResponseDto,
  TicketBrandParamDto,
} from '../dto.js';
import { BulkService } from './bulk.service.js';

/**
 * M14-03 over HTTP (DOMAIN-RULES §2.7). `ticket:write` for the route, as for a
 * single edit; which tickets the caller may change is decided per ticket, by the
 * same department policy and the same rules, inside the service. Staff only and
 * not in the public API v1.
 *
 * Both routes answer 200: a preview creates nothing, and an apply's result is
 * the per-ticket report, with the operation id Undo takes.
 */
@Controller('api/brands/:brandId/tickets/bulk')
export class BulkController {
  readonly #bulk: BulkService;

  constructor(@Inject(BulkService) bulk: BulkService) {
    this.#bulk = bulk;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @ZodSerializerDto(BulkResponseDto)
  run(
    @Param(new ZodValidationPipe(TicketBrandParamDto)) { brandId }: TicketBrandParamDto,
    @Body(new ZodValidationPipe(BulkRequestDto)) body: BulkRequestDto,
  ): Promise<BulkResponse> {
    return this.#bulk.run(brandId, this.#principal(), body);
  }

  @Post(':operationId/undo')
  @HttpCode(HttpStatus.OK)
  @Requires('ticket:write')
  @ZodSerializerDto(BulkUndoResponseDto)
  undo(
    @Param(new ZodValidationPipe(BulkOperationParamDto))
    { brandId, operationId }: BulkOperationParamDto,
  ): Promise<BulkUndoResponse> {
    return this.#bulk.undo(brandId, this.#principal(), operationId);
  }

  #principal(): Principal {
    const principal = requireRequestContext().principal;
    /* c8 ignore next 3 -- the guard refuses the request before a handler runs. */
    if (principal === null) {
      throw new Error('The authentication guard let an unauthenticated request through');
    }

    return principal;
  }
}

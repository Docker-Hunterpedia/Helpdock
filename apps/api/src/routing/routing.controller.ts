import type { RoutingOverview, RoutingTestResult } from '@helpdock/schemas';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { Requires } from '../auth/route-declaration.js';
import { requireTicketingContext } from '../ticketing/ticketing-context.js';
import {
  RoutingBrandParamDto,
  RoutingOverviewDto,
  RoutingTestRequestDto,
  RoutingTestResultDto,
} from './dto.js';
import { RoutingService } from './routing.service.js';

/**
 * `Admin/Automation-Routing` (M14-09): how a new ticket is routed, and a dry
 * run of it. Both routes are `ticketing:manage`, as the rules they explain are.
 */
@Controller('api/brands/:brandId/routing')
export class RoutingController {
  readonly #routing: RoutingService;

  constructor(@Inject(RoutingService) routing: RoutingService) {
    this.#routing = routing;
  }

  @Get()
  @Requires('ticketing:manage')
  @ZodSerializerDto(RoutingOverviewDto)
  overview(
    @Param(new ZodValidationPipe(RoutingBrandParamDto)) _params: RoutingBrandParamDto,
  ): Promise<RoutingOverview> {
    return this.#routing.overview(requireTicketingContext());
  }

  /** A `POST` because it carries a sample message; it creates, sends and logs nothing. */
  @Post('test')
  @Requires('ticketing:manage')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(RoutingTestResultDto)
  test(
    @Param(new ZodValidationPipe(RoutingBrandParamDto)) _params: RoutingBrandParamDto,
    @Body(new ZodValidationPipe(RoutingTestRequestDto)) body: RoutingTestRequestDto,
  ): Promise<RoutingTestResult> {
    return this.#routing.test(requireTicketingContext(), body);
  }
}

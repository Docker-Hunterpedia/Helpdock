import {
  brandIdParamSchema,
  routingOverviewSchema,
  routingTestRequestSchema,
  routingTestResultSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The routing schemas as Nest DTOs, declared here for the reason `tickets/dto.ts` gives. */
export class RoutingBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class RoutingOverviewDto extends createZodDto(routingOverviewSchema) {}
export class RoutingTestRequestDto extends createZodDto(routingTestRequestSchema) {}
export class RoutingTestResultDto extends createZodDto(routingTestResultSchema) {}

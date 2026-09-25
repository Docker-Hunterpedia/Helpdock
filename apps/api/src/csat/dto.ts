import { csatSubmitRequestSchema, csatTokenParamSchema } from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The CSAT schemas as Nest DTOs, declared here for the reason `tickets/dto.ts`
 * gives: `createZodDto` pulls in `@nestjs/common`, and `@helpdock/schemas` is
 * imported by `apps/admin` too.
 */

export class CsatTokenParamDto extends createZodDto(csatTokenParamSchema) {}
export class CsatSubmitRequestDto extends createZodDto(csatSubmitRequestSchema) {}

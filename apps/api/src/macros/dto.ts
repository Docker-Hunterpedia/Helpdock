import {
  brandIdParamSchema,
  macroCreateRequestSchema,
  macroListQuerySchema,
  macroListSchema,
  macroParamSchema,
  macroRenderQuerySchema,
  macroRunRequestSchema,
  macroRunResponseSchema,
  macroSchema,
  macroTicketParamSchema,
  macroUpdateRequestSchema,
  renderedMacroSchema,
  ticketParamSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The macro schemas as Nest DTOs, declared here for the reason
 * `tickets/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` too.
 */

export class MacroDto extends createZodDto(macroSchema) {}
export class MacroListDto extends createZodDto(macroListSchema) {}
export class MacroListQueryDto extends createZodDto(macroListQuerySchema) {}
export class MacroCreateRequestDto extends createZodDto(macroCreateRequestSchema) {}
export class MacroUpdateRequestDto extends createZodDto(macroUpdateRequestSchema) {}
export class RenderedMacroDto extends createZodDto(renderedMacroSchema) {}
export class MacroRenderQueryDto extends createZodDto(macroRenderQuerySchema) {}
export class MacroRunRequestDto extends createZodDto(macroRunRequestSchema) {}
export class MacroRunResponseDto extends createZodDto(macroRunResponseSchema) {}

export class MacrosBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class MacroParamDto extends createZodDto(macroParamSchema) {}
export class MacroTicketParamDto extends createZodDto(macroTicketParamSchema) {}
export class MacroRunParamDto extends createZodDto(ticketParamSchema) {}

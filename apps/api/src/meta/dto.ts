import {
  metaAppSchema,
  metaDeliveryListSchema,
  metaDeliveryParamSchema,
  metaTicketContextResponseSchema,
  metaTicketParamSchema,
  metaVerifyTokenRevealSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The Meta routes' DTOs (M10). Each deliverable that adds routes adds its
 * wrappers here, as the Telegram module's `dto.ts` grew: M10-02 has the App
 * card's two, M10-06 the ticket's, M10-07 the accounts'.
 */

export class MetaAppDto extends createZodDto(metaAppSchema) {}
export class MetaVerifyTokenRevealDto extends createZodDto(metaVerifyTokenRevealSchema) {}

export class MetaTicketParamDto extends createZodDto(metaTicketParamSchema) {}
export class MetaDeliveryParamDto extends createZodDto(metaDeliveryParamSchema) {}
export class MetaDeliveryListDto extends createZodDto(metaDeliveryListSchema) {}
export class MetaTicketContextDto extends createZodDto(metaTicketContextResponseSchema) {}

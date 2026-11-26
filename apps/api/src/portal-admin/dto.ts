import {
  accountIdParamSchema,
  accountPortalSchema,
  accountPortalUpdateSchema,
  brandIdParamSchema,
  contactIdParamSchema,
  contactPortalAccessSchema,
  contactPortalSignOutSchema,
  portalSettingsSchema,
  portalSettingsUpdateSchema,
  ticketParamSchema,
  ticketPortalPrivateUpdateSchema,
  ticketPortalViewSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** Declared here, not in `@helpdock/schemas`, for the reason `tickets/dto.ts` gives. */
export class PortalBrandParamDto extends createZodDto(brandIdParamSchema) {}
export class PortalAccountParamDto extends createZodDto(accountIdParamSchema) {}
export class PortalContactParamDto extends createZodDto(contactIdParamSchema) {}
export class PortalTicketParamDto extends createZodDto(ticketParamSchema) {}

export class PortalSettingsDto extends createZodDto(portalSettingsSchema) {}
export class PortalSettingsUpdateDto extends createZodDto(portalSettingsUpdateSchema) {}
export class AccountPortalDto extends createZodDto(accountPortalSchema) {}
export class AccountPortalUpdateDto extends createZodDto(accountPortalUpdateSchema) {}
export class ContactPortalAccessDto extends createZodDto(contactPortalAccessSchema) {}
export class ContactPortalSignOutDto extends createZodDto(contactPortalSignOutSchema) {}
export class TicketPortalPrivateUpdateDto extends createZodDto(ticketPortalPrivateUpdateSchema) {}
export class TicketPortalViewDto extends createZodDto(ticketPortalViewSchema) {}

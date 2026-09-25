import {
  accountCreateRequestSchema,
  accountDetailSchema,
  accountIdParamSchema,
  accountListSchema,
  accountSchema,
  accountSearchQuerySchema,
  accountUpdateRequestSchema,
  contactCreateRequestSchema,
  contactDetailSchema,
  contactDuplicateParamSchema,
  contactIdentityInputSchema,
  contactIdentityParamSchema,
  contactIdParamSchema,
  contactListSchema,
  contactMergeParamSchema,
  contactMergePreviewQuerySchema,
  contactMergePreviewSchema,
  contactMergeRequestSchema,
  contactNoteRequestSchema,
  contactSearchQuerySchema,
  contactTimelineSchema,
  contactUpdateRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The contact schemas as Nest DTOs, declared here for the reason
 * `routes/dto.ts` gives: `createZodDto` pulls in `@nestjs/common`, and
 * `@helpdock/schemas` is imported by `apps/admin` and `apps/widget` too.
 *
 * Every handler names an output DTO with `@ZodSerializerDto`, so a column a
 * later milestone adds to `contacts` cannot leak by being returned
 * (ARCHITECTURE §6, step 5) — which matters more here than anywhere else in the
 * api, because every column of these tables is personal data.
 */

export class ContactListDto extends createZodDto(contactListSchema) {}
export class ContactDetailDto extends createZodDto(contactDetailSchema) {}
export class ContactTimelineDto extends createZodDto(contactTimelineSchema) {}
export class ContactSearchQueryDto extends createZodDto(contactSearchQuerySchema) {}

export class ContactCreateRequestDto extends createZodDto(contactCreateRequestSchema) {}
export class ContactUpdateRequestDto extends createZodDto(contactUpdateRequestSchema) {}
export class ContactIdentityInputDto extends createZodDto(contactIdentityInputSchema) {}
export class ContactNoteRequestDto extends createZodDto(contactNoteRequestSchema) {}

export class ContactIdParamDto extends createZodDto(contactIdParamSchema) {}
export class ContactIdentityParamDto extends createZodDto(contactIdentityParamSchema) {}
export class ContactDuplicateParamDto extends createZodDto(contactDuplicateParamSchema) {}

export class AccountDto extends createZodDto(accountSchema) {}
export class AccountListDto extends createZodDto(accountListSchema) {}
export class AccountDetailDto extends createZodDto(accountDetailSchema) {}
export class AccountSearchQueryDto extends createZodDto(accountSearchQuerySchema) {}
export class AccountCreateRequestDto extends createZodDto(accountCreateRequestSchema) {}
export class AccountUpdateRequestDto extends createZodDto(accountUpdateRequestSchema) {}
export class AccountIdParamDto extends createZodDto(accountIdParamSchema) {}

// M1-13: merging two contacts, and the undo.
export class ContactMergeRequestDto extends createZodDto(contactMergeRequestSchema) {}
export class ContactMergeParamDto extends createZodDto(contactMergeParamSchema) {}
export class ContactMergePreviewQueryDto extends createZodDto(contactMergePreviewQuerySchema) {}
export class ContactMergePreviewDto extends createZodDto(contactMergePreviewSchema) {}

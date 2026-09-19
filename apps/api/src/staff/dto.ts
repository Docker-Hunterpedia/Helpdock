import {
  brandStaffParamSchema,
  inviteAcceptRequestSchema,
  inviteTokenParamSchema,
  passwordChangeRequestSchema,
  profileSchema,
  profileUpdateRequestSchema,
  publicInviteSchema,
  recoveryCodesSchema,
  sessionFamilyParamSchema,
  staffInviteRequestSchema,
  staffListSchema,
  staffMemberSchema,
  staffSearchQuerySchema,
  staffSessionListSchema,
  staffUpdateRequestSchema,
  staffUserIdParamSchema,
  totpCodeRequestSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * The staff schemas as Nest DTOs, declared here for the reason `routes/dto.ts`
 * gives: `createZodDto` pulls in `@nestjs/common`, and `@helpdock/schemas` is
 * imported by `apps/admin` too.
 *
 * Every handler names an output DTO with `@ZodSerializerDto`, so a column a
 * later milestone adds cannot leak by being returned (ARCHITECTURE §6, step 5).
 */

export class StaffListDto extends createZodDto(staffListSchema) {}
export class StaffMemberDto extends createZodDto(staffMemberSchema) {}
export class StaffSearchQueryDto extends createZodDto(staffSearchQuerySchema) {}

export class StaffInviteRequestDto extends createZodDto(staffInviteRequestSchema) {}
export class StaffUpdateRequestDto extends createZodDto(staffUpdateRequestSchema) {}
export class StaffUserIdParamDto extends createZodDto(staffUserIdParamSchema) {}
export class BrandStaffParamDto extends createZodDto(brandStaffParamSchema) {}

export class PublicInviteDto extends createZodDto(publicInviteSchema) {}
export class InviteAcceptRequestDto extends createZodDto(inviteAcceptRequestSchema) {}
export class InviteTokenParamDto extends createZodDto(inviteTokenParamSchema) {}

export class ProfileDto extends createZodDto(profileSchema) {}
export class ProfileUpdateRequestDto extends createZodDto(profileUpdateRequestSchema) {}
export class PasswordChangeRequestDto extends createZodDto(passwordChangeRequestSchema) {}
export class TotpCodeRequestDto extends createZodDto(totpCodeRequestSchema) {}
export class StaffSessionListDto extends createZodDto(staffSessionListSchema) {}
export class SessionFamilyParamDto extends createZodDto(sessionFamilyParamSchema) {}
export class RecoveryCodesDto extends createZodDto(recoveryCodesSchema) {}

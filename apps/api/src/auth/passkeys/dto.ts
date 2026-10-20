import {
  passkeyAddedSchema,
  passkeyBeginRequestSchema,
  passkeyFinishRequestSchema,
  passkeyIdParamSchema,
  passkeyListSchema,
  passkeyRecoveryRedrawRequestSchema,
  passkeyRegistrationOptionsSchema,
  passkeyRemoveRequestSchema,
  passkeyRenameRequestSchema,
  passkeySchema,
  passkeyStepUpOptionsSchema,
} from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

export class PasskeyListDto extends createZodDto(passkeyListSchema) {}
export class PasskeyAddedDto extends createZodDto(passkeyAddedSchema) {}
export class PasskeyRecoveryRedrawRequestDto extends createZodDto(
  passkeyRecoveryRedrawRequestSchema,
) {}
export class PasskeyDto extends createZodDto(passkeySchema) {}
export class PasskeyIdParamDto extends createZodDto(passkeyIdParamSchema) {}
export class PasskeyBeginRequestDto extends createZodDto(passkeyBeginRequestSchema) {}
export class PasskeyFinishRequestDto extends createZodDto(passkeyFinishRequestSchema) {}
export class PasskeyRenameRequestDto extends createZodDto(passkeyRenameRequestSchema) {}
export class PasskeyRemoveRequestDto extends createZodDto(passkeyRemoveRequestSchema) {}
export class PasskeyRegistrationOptionsDto extends createZodDto(passkeyRegistrationOptionsSchema) {}
export class PasskeyStepUpOptionsDto extends createZodDto(passkeyStepUpOptionsSchema) {}

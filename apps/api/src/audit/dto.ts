import { auditLogPageSchema, auditLogQuerySchema } from '@helpdock/schemas';
import { createZodDto } from 'nestjs-zod';

/** The audit viewer's schemas as Nest DTOs, for the reason `tickets/dto.ts` gives. */
export class AuditLogPageDto extends createZodDto(auditLogPageSchema) {}
export class AuditLogQueryDto extends createZodDto(auditLogQuerySchema) {}

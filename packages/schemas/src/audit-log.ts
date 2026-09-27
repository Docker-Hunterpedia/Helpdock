import { z } from 'zod';

/**
 * The admin audit log viewer (M3-08, REQUIREMENTS §4.10 "System: … audit log").
 *
 * Install-wide and read-only: an install admin reads every brand's rows and the
 * install's own, newest first, and nothing here edits or deletes one — retention
 * does that (DOMAIN-RULES §11).
 *
 * **`meta` never crosses the wire as it is stored.** The api turns it into
 * `changes` (a field that has a before and an after) and `details` (anything
 * else the row recorded), and replaces every value whose name says it is a
 * secret with `[redacted]` on the way. A writer that one day records a
 * password by mistake is still not a reader that shows it.
 */

export const AUDIT_PAGE_SIZE = 50;
/** What a redacted value reads as, in both languages; it is a marker, not prose. */
export const AUDIT_REDACTED = '[redacted]';

export const auditActorTypeSchema = z.enum(['staff', 'visitor', 'apikey', 'system']);

export const auditChangeSchema = z.object({
  /** A dotted path into what changed, e.g. `smtp.host` or `to.role`. */
  field: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** The name says it is a secret: both sides read `[redacted]`. */
  secret: z.boolean(),
});
export type AuditChange = z.infer<typeof auditChangeSchema>;

export const auditDetailSchema = z.object({
  field: z.string(),
  value: z.string().nullable(),
  secret: z.boolean(),
});
export type AuditDetail = z.infer<typeof auditDetailSchema>;

export const auditRecordSchema = z.object({
  id: z.uuid(),
  /** Null for an install-wide row. */
  brandId: z.uuid().nullable(),
  brandName: z.string().nullable(),
  actorType: auditActorTypeSchema,
  actorId: z.string().min(1),
  /** A staff member's name, when the actor is one who still exists. */
  actorName: z.string().nullable(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().nullable(),
  /** Where the request came from; null for a worker and for rows older than M3-08. */
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
  changes: z.array(auditChangeSchema),
  details: z.array(auditDetailSchema),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export const auditLogPageSchema = z.object({
  entries: z.array(auditRecordSchema),
  /** Pass back as `cursor` for the next, older page. Null on the last one. */
  nextCursor: z.string().nullable(),
  /** Every brand, for the Brand filter. */
  brands: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type AuditLogPage = z.infer<typeof auditLogPageSchema>;

/**
 * An exact action, or a family written `ticket.*`. Anything else — a `%`, a
 * space — is refused, because the value reaches a `LIKE`.
 */
export const auditActionFilterSchema = z
  .string()
  .trim()
  .max(80)
  .regex(/^[a-z_]+(\.[a-z_]+)*(\.\*)?$/, 'An action, or a family such as ticket.*');

/** The install-wide rows' own filter value, since they carry no brand. */
export const AUDIT_INSTALL_BRAND = 'install';

export const auditLogQuerySchema = z
  .object({
    /** A staff member's name or email, or an actor id. */
    actor: z.string().trim().min(1).max(120).optional(),
    action: auditActionFilterSchema.optional(),
    targetType: z
      .string()
      .trim()
      .max(40)
      .regex(/^[a-z_]+$/)
      .optional(),
    /** A brand id, or `install` for the install-wide rows. */
    brand: z.union([z.uuid(), z.literal(AUDIT_INSTALL_BRAND)]).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(AUDIT_PAGE_SIZE),
  })
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      Date.parse(value.from) <= Date.parse(value.to),
    'The range ends before it starts',
  );
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

import {
  type DbTransaction,
  importMappings,
  importRecords,
  importRuns,
  retentionSettings,
  ticketStatuses,
} from '@helpdock/db';
import {
  type ImportRecord,
  importEntitySchema,
  importMappingSchema,
  importSourceSchema,
} from '@helpdock/schemas';
import { and, eq, gt, or } from 'drizzle-orm';
import { z } from 'zod';
import { importRunRefSchema } from '../jobs/claims.js';
import { ImportLoadError } from '../loader/contracts.js';
import type { ImportScope } from '../loader/external-ids.js';
import { selectTicketMappings } from '../loader/ticket-mapping-selection.js';
import { previewImportedContactSource } from './contact-source-plan.js';
import { previewImportedCustom } from './custom-values.js';
import {
  contactIdentityProjection,
  importIdentityProjectionSchema,
  organizationIdentityProjection,
} from './identity-projection.js';
import { previewImportedOrganization } from './organization-plan.js';
import { validateImportReferences } from './record-references.js';
import { validatedStagedRecord } from './staged-record.js';
import { validateImportTicketRouting } from './ticket-routing.js';

export const importRecordCursorSchema = z.strictObject({
  entity: importEntitySchema,
  externalId: z.string().min(1).max(200),
});
const requestSchema = importRunRefSchema.extend({
  source: importSourceSchema,
  after: importRecordCursorSchema.nullable().default(null),
  batchSize: z.int().min(1).max(50).default(25),
  defaultCallingCode: z
    .string()
    .regex(/^\d{0,4}$/)
    .default(''),
});
export const importRecordIssueSchema = importRecordCursorSchema.extend({
  code: z.string().min(1).max(100),
});
const pageSchema = z.strictObject({
  checked: z.int().nonnegative().max(50),
  issueCount: z.int().nonnegative(),
  issues: z.array(importRecordIssueSchema).max(100),
  warningCount: z.int().nonnegative(),
  warnings: z.array(importRecordIssueSchema).max(100),
  refusedPhones: z.int().nonnegative(),
  next: importRecordCursorSchema.nullable(),
  identityPlans: z
    .array(z.strictObject({ recordId: z.uuid(), projection: importIdentityProjectionSchema }))
    .max(50),
});
type Mapping = z.infer<typeof importMappingSchema>;

async function profilePlan(
  tx: DbTransaction,
  request: {
    scope: ImportScope;
    record: ImportRecord;
    defaultCallingCode: string;
    inputHash: string;
  },
) {
  const { scope, record, defaultCallingCode, inputHash } = request;
  if (record.entity === 'contact') {
    const plan = await previewImportedContactSource(tx, {
      ...scope,
      record: record.payload,
      defaultCallingCode,
    });
    return {
      projection: contactIdentityProjection({
        externalId: record.payload.externalId,
        inputHash,
        plan,
      }),
      refusedPhones: plan.refusedPhones,
    };
  } else if (record.entity === 'organization') {
    const custom = await previewImportedCustom(tx, {
      ...scope,
      target: 'account',
      custom: record.payload.custom,
      operation: 'patch',
    });
    const plan = await previewImportedOrganization(tx, {
      ...scope,
      record: record.payload,
      custom,
    });
    if (plan.action === 'create')
      await previewImportedCustom(tx, {
        ...scope,
        target: 'account',
        custom: record.payload.custom,
        operation: 'create',
      });
    return {
      projection: organizationIdentityProjection({
        externalId: record.payload.externalId,
        inputHash,
        plan,
      }),
      refusedPhones: 0,
    };
  }
  return { projection: null, refusedPhones: 0 };
}

async function recordIssues(
  tx: DbTransaction,
  request: {
    scope: ImportScope;
    row: typeof importRecords.$inferSelect;
    mappings: Mapping[];
    defaultCallingCode: string;
  },
) {
  const { scope, row, mappings, defaultCallingCode } = request;
  const codes: string[] = [];
  try {
    const record = validatedStagedRecord(row);
    codes.push(...(await validateImportReferences(tx, scope, record)).map((issue) => issue.code));
    if (record.entity === 'ticket') {
      const routing = await validateImportTicketRouting(tx, scope, record.payload, mappings);
      if (routing) codes.push(routing);
      await previewImportedCustom(tx, {
        ...scope,
        target: 'ticket',
        custom: record.payload.custom,
        operation: 'create',
      });
    }
    const profile = await profilePlan(tx, {
      scope,
      record,
      defaultCallingCode,
      inputHash: row.payloadHash,
    });
    return { codes, ...profile };
  } catch (error) {
    if (error instanceof ImportLoadError)
      return { codes: [...codes, error.code], projection: null, refusedPhones: 0 };
    if (error instanceof z.ZodError)
      return { codes: [...codes, 'mapping-invalid'], projection: null, refusedPhones: 0 };
    throw error;
  }
}

/** Paged structural/profile validation only; a page does not approve a run or mutate staged status. */
export async function validateImportRecordPage(
  tx: DbTransaction,
  raw: z.input<typeof requestSchema>,
) {
  const { after, batchSize, defaultCallingCode, ...scope } = requestSchema.parse(raw);
  const [run] = await tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, scope.brandId),
        eq(importRuns.id, scope.runId),
        eq(importRuns.source, scope.source),
      ),
    );
  if (!run) throw new ImportLoadError('target-unavailable');
  const mappings = (
    await tx
      .select()
      .from(importMappings)
      .where(and(eq(importMappings.brandId, scope.brandId), eq(importMappings.runId, scope.runId)))
  ).map((row) =>
    importMappingSchema.parse({
      kind: row.kind,
      externalValue: row.externalValue,
      target: row.target,
    }),
  );
  const [retention] = await tx
    .select({ days: retentionSettings.closedTicketDays })
    .from(retentionSettings)
    .where(eq(retentionSettings.brandId, scope.brandId));
  const retentionCutoff = retention?.days ? Date.now() - retention.days * 86_400_000 : null;
  const closedStatuses =
    retentionCutoff === null
      ? []
      : await tx
          .select({ id: ticketStatuses.id })
          .from(ticketStatuses)
          .where(
            and(
              eq(ticketStatuses.brandId, scope.brandId),
              eq(ticketStatuses.systemState, 'closed'),
            ),
          );
  const closedStatusIds = new Set(closedStatuses.map((status) => status.id));
  const rows = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        after
          ? or(
              gt(importRecords.entity, after.entity),
              and(
                eq(importRecords.entity, after.entity),
                gt(importRecords.externalId, after.externalId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(importRecords.entity, importRecords.externalId)
    .limit(batchSize + 1);
  const issues: z.infer<typeof importRecordIssueSchema>[] = [];
  let issueCount = 0;
  let warningCount = 0;
  let refusedPhones = 0;
  const warnings: z.infer<typeof importRecordIssueSchema>[] = [];
  const page = rows.slice(0, batchSize);
  const identityPlans: z.infer<typeof pageSchema>['identityPlans'] = [];
  for (const row of page) {
    const {
      codes,
      projection,
      refusedPhones: refused,
    } = await recordIssues(tx, {
      scope,
      row,
      mappings,
      defaultCallingCode,
    });
    if (row.entity === 'ticket' && codes.length === 0 && retentionCutoff !== null) {
      const record = validatedStagedRecord(row);
      if (record.entity === 'ticket') {
        const { statusId } = selectTicketMappings(record.payload, mappings);
        const closedAt = Date.parse(
          record.payload.closedAt ?? record.payload.solvedAt ?? record.payload.updatedAt,
        );
        if (closedStatusIds.has(statusId) && closedAt < retentionCutoff) {
          warningCount++;
          if (warnings.length < 100)
            warnings.push({
              entity: 'ticket',
              externalId: row.externalId,
              code: 'retention-closed-history',
            });
        }
      }
    }
    refusedPhones += refused;
    if (refused > 0) {
      warningCount++;
      if (warnings.length < 100)
        warnings.push({ entity: row.entity, externalId: row.externalId, code: 'phone-refused' });
    }
    if (projection) identityPlans.push({ recordId: row.id, projection });
    issueCount += codes.length;
    for (const code of codes)
      if (issues.length < 100)
        issues.push({ entity: row.entity, externalId: row.externalId, code });
  }
  const last = page.at(-1);
  return pageSchema.parse({
    checked: page.length,
    issueCount,
    issues,
    identityPlans,
    warningCount,
    warnings,
    refusedPhones,
    next:
      rows.length > batchSize && last ? { entity: last.entity, externalId: last.externalId } : null,
  });
}

import { type DbTransaction, importMappings, importRecords, importRuns } from '@helpdock/db';
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
import { previewImportedContactSource } from './contact-source-plan.js';
import { previewImportedCustom } from './custom-values.js';
import { previewImportedOrganization } from './organization-plan.js';
import { validateImportReferences } from './record-references.js';
import { validatedStagedRecord } from './staged-record.js';
import { validateImportTicketRouting } from './ticket-routing.js';

const cursorSchema = z.strictObject({
  entity: importEntitySchema,
  externalId: z.string().min(1).max(200),
});
const requestSchema = importRunRefSchema.extend({
  source: importSourceSchema,
  after: cursorSchema.nullable().default(null),
  batchSize: z.int().min(1).max(50).default(25),
  defaultCallingCode: z
    .string()
    .regex(/^\d{0,4}$/)
    .default(''),
});
const issueSchema = cursorSchema.extend({ code: z.string().min(1).max(100) });
const pageSchema = z.strictObject({
  checked: z.int().nonnegative().max(50),
  issueCount: z.int().nonnegative(),
  issues: z.array(issueSchema).max(100),
  next: cursorSchema.nullable(),
});
type Mapping = z.infer<typeof importMappingSchema>;

async function profileIssues(
  tx: DbTransaction,
  scope: ImportScope,
  record: ImportRecord,
  defaultCallingCode: string,
) {
  if (record.entity === 'contact') {
    await previewImportedContactSource(tx, {
      ...scope,
      record: record.payload,
      defaultCallingCode,
    });
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
  }
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
        operation: 'patch',
      });
    }
    await profileIssues(tx, scope, record, defaultCallingCode);
    return codes;
  } catch (error) {
    if (error instanceof ImportLoadError) return [...codes, error.code];
    if (error instanceof z.ZodError) return [...codes, 'mapping-invalid'];
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
  const issues: z.infer<typeof issueSchema>[] = [];
  let issueCount = 0;
  const page = rows.slice(0, batchSize);
  for (const row of page) {
    const codes = await recordIssues(tx, { scope, row, mappings, defaultCallingCode });
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
    next:
      rows.length > batchSize && last ? { entity: last.entity, externalId: last.externalId } : null,
  });
}

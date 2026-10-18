import { type DbTransaction, importMappings } from '@helpdock/db';
import { type ImportMapping, importMappingSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from '../loader/contracts.js';
import type { ImportScope } from '../loader/external-ids.js';
import { validateImportFieldPlan } from './field-plan-state.js';
import { validateImportInvitationPlan } from './invitation-plan-state.js';
import { validateImportMappingTarget } from './mapping-targets.js';

export const importMappingPlanIssueSchema = z.strictObject({
  area: z.enum(['mapping', 'field', 'invitation']),
  externalId: z.string().max(300),
  code: z.string().min(1).max(100),
});
const reportSchema = z.strictObject({
  checked: z.int().nonnegative(),
  issueCount: z.int().nonnegative(),
  issues: z.array(importMappingPlanIssueSchema).max(100),
});

async function mappingTargetCode(tx: DbTransaction, scope: ImportScope, mapping: ImportMapping) {
  try {
    return await validateImportMappingTarget(tx, scope, mapping);
  } catch (error) {
    if (error instanceof ImportLoadError || error instanceof z.ZodError) return 'mapping-invalid';
    throw error;
  }
}

/** Validate live destinations and combined additions without provisioning or exposing email values. */
export async function validateImportMappingPlan(tx: DbTransaction, scope: ImportScope) {
  const rows = await tx
    .select()
    .from(importMappings)
    .where(and(eq(importMappings.brandId, scope.brandId), eq(importMappings.runId, scope.runId)));
  const mappings: ImportMapping[] = [];
  const issues: z.infer<typeof importMappingPlanIssueSchema>[] = [];
  for (const row of rows) {
    const parsed = importMappingSchema.safeParse({
      kind: row.kind,
      externalValue: row.externalValue,
      target: row.target,
    });
    if (!parsed.success) {
      issues.push({ area: 'mapping', externalId: row.externalValue, code: 'mapping-invalid' });
      continue;
    }
    mappings.push(parsed.data);
    const code = await mappingTargetCode(tx, scope, parsed.data);
    if (code) issues.push({ area: 'mapping', externalId: row.externalValue, code });
  }
  issues.push(
    ...(await validateImportFieldPlan(tx, scope, mappings)).map((issue) => ({
      ...issue,
      area: 'field' as const,
    })),
  );
  issues.push(
    ...(await validateImportInvitationPlan(tx, scope, mappings)).map((issue) => ({
      ...issue,
      area: 'invitation' as const,
    })),
  );
  return reportSchema.parse({
    checked: rows.length,
    issueCount: issues.length,
    issues: issues.slice(0, 100),
  });
}

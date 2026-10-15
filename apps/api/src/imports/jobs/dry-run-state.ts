import { type DbTransaction, importRuns } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { importMappingPlanIssueSchema } from '../preflight/mapping-plan.js';
import { importRecordCursorSchema, importRecordIssueSchema } from '../preflight/record-page.js';
import type { importClaimSchema } from './claims.js';

const callingCodeSchema = z.string().regex(/^\d{0,4}$/);
export const importDryRunCheckpointSchema = z.strictObject({
  version: z.literal(2),
  phase: z.enum([
    'records',
    'records_checked',
    'plans_checked',
    'identities_checked',
    'media_checked',
    'invalidated',
  ]),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  defaultCallingCode: callingCodeSchema,
  after: importRecordCursorSchema.nullable(),
  checked: z.int().nonnegative(),
  issueCount: z.int().nonnegative(),
  issues: z.array(importRecordIssueSchema).max(100),
  mappingsChecked: z.int().nonnegative().default(0),
  planIssueCount: z.int().nonnegative().default(0),
  planIssues: z.array(importMappingPlanIssueSchema).max(100).default([]),
  identityIssueCount: z.int().nonnegative().default(0),
  identityIssues: z.array(importRecordIssueSchema).max(100).default([]),
  mediaAfter: z.uuid().nullable().default(null),
  mediaChecked: z.int().nonnegative().default(0),
  mediaWarnings: z.int().nonnegative().default(0),
  mediaErrors: z.int().nonnegative().default(0),
  mediaPolicyHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  mediaIssues: z
    .array(importRecordIssueSchema.extend({ level: z.enum(['warning', 'error']) }))
    .max(100)
    .default([]),
});
export async function storeImportDryRunCheckpoint(
  tx: DbTransaction,
  claim: z.infer<typeof importClaimSchema>,
  checkpoint: z.infer<typeof importDryRunCheckpointSchema>,
) {
  await tx
    .update(importRuns)
    .set({
      dryRunReport: checkpoint,
      ...(checkpoint.phase === 'invalidated'
        ? { status: 'awaiting_mapping' as const, claimToken: null, claimedAt: null }
        : {}),
    })
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
}

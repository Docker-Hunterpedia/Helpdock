import { brands, type DbTransaction, importRuns, uuidv7 } from '@helpdock/db';
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { countsWithoutPendingImportWork } from './pending-work.js';
import { extractionRetry } from './retry-state.js';

export const importPhaseSchema = z.enum(['extracting', 'dry_run', 'loading', 'finishing']);
export const importRunRefSchema = z.strictObject({ brandId: z.uuid(), runId: z.uuid() });
export const importClaimSchema = importRunRefSchema.extend({
  token: z.uuid(),
  phase: importPhaseSchema,
});
export type ImportRunRef = z.infer<typeof importRunRefSchema>;
export type ImportClaim = z.infer<typeof importClaimSchema>;
export const IMPORT_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;

export class ImportClaimLost extends Error {
  constructor() {
    super('import.claim-lost');
    this.name = 'ImportClaimLost';
  }
}

/** Claims, controls and batch commits share a brand lock, always before a run-row lock. */
export async function lockImportBrand(tx: DbTransaction, brandId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${brandId}, 26))`);
}

async function activeImportBrand(tx: DbTransaction, brandId: string): Promise<boolean> {
  const [brand] = await tx
    .select({ status: brands.status })
    .from(brands)
    .where(eq(brands.id, brandId));
  return brand?.status === 'active';
}

async function claimableRun(
  tx: DbTransaction,
  scope: ImportRunRef & { phase: ImportClaim['phase'] },
  now: Date,
): Promise<boolean> {
  const [run] = await tx
    .select({ id: importRuns.id, counts: importRuns.counts })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, scope.brandId),
        eq(importRuns.id, scope.runId),
        eq(importRuns.status, scope.phase),
      ),
    )
    .for('update');
  if (!run) return false;
  const retry = extractionRetry(run.counts);
  return !retry.retryAt || Date.parse(retry.retryAt) <= now.getTime();
}

async function freshBrandClaim(tx: DbTransaction, brandId: string, stale: Date): Promise<boolean> {
  const busy = await tx
    .select({ id: importRuns.id })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.brandId, brandId),
        isNotNull(importRuns.claimToken),
        gte(importRuns.claimedAt, stale),
      ),
    )
    .limit(1);
  return busy.length > 0;
}

async function clearStaleClaims(tx: DbTransaction, brandId: string, stale: Date): Promise<void> {
  await tx
    .update(importRuns)
    .set({ claimToken: null, claimedAt: null })
    .where(
      and(
        eq(importRuns.brandId, brandId),
        isNotNull(importRuns.claimToken),
        lte(importRuns.claimedAt, stale),
      ),
    );
}

export async function claimImportRun(
  tx: DbTransaction,
  request: ImportRunRef & { phase: ImportClaim['phase'] },
  now = new Date(),
): Promise<ImportClaim | null> {
  const input = importRunRefSchema.extend({ phase: importPhaseSchema }).parse(request);
  await lockImportBrand(tx, input.brandId);
  if (!(await activeImportBrand(tx, input.brandId)) || !(await claimableRun(tx, input, now)))
    return null;
  const stale = new Date(now.getTime() - IMPORT_CLAIM_TIMEOUT_MS);
  if (await freshBrandClaim(tx, input.brandId, stale)) return null;
  await clearStaleClaims(tx, input.brandId, stale);
  const token = uuidv7();
  await tx
    .update(importRuns)
    .set({
      claimToken: token,
      claimedAt: now,
      counts: countsWithoutPendingImportWork(),
      startedAt: sql`coalesce(${importRuns.startedAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(eq(importRuns.id, input.runId));
  return { ...input, token };
}

/** Call only inside the batch transaction; a cancelled or replaced worker cannot renew its authority. */
export async function renewImportClaim(
  tx: DbTransaction,
  request: ImportClaim,
  now = new Date(),
): Promise<void> {
  const claim = importClaimSchema.parse(request);
  await lockImportBrand(tx, claim.brandId);
  if (!(await activeImportBrand(tx, claim.brandId))) throw new ImportClaimLost();
  const updated = await tx
    .update(importRuns)
    .set({ claimedAt: now })
    .where(
      and(
        eq(importRuns.brandId, claim.brandId),
        eq(importRuns.id, claim.runId),
        eq(importRuns.claimToken, claim.token),
        eq(importRuns.status, claim.phase),
      ),
    )
    .returning({ id: importRuns.id });
  if (!updated.length) throw new ImportClaimLost();
}

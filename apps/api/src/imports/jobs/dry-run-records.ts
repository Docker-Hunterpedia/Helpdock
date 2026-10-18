import { type Db, importRecords, importRuns } from '@helpdock/db';
import { importScopeSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportLoadError } from '../loader/contracts.js';
import { validateImportIdentityPlan } from '../preflight/identity-plan-state.js';
import { validateImportMappingPlan } from '../preflight/mapping-plan.js';
import { validateImportRecordPage } from '../preflight/record-page.js';
import { ImportClaimLost, importClaimSchema, renewImportClaim } from './claims.js';
import { importDestinationFingerprint } from './destination-fingerprint.js';
import { importDryRunCheckpointSchema, storeImportDryRunCheckpoint } from './dry-run-state.js';
import { importFileSourceWarnings } from './file-source-warnings.js';
import { importInputFingerprint } from './input-fingerprint.js';
import { importVendorSourceWarnings } from './vendor-source-warnings.js';

const callingCodeSchema = z.string().regex(/^\d{0,4}$/);
const requestSchema = z.strictObject({
  claim: importClaimSchema,
  batchSize: z.int().min(1).max(50).default(25),
  defaultCallingCode: callingCodeSchema.default(''),
});
const resultSchema = z.strictObject({
  state: z.enum([
    'more',
    'records_checked',
    'plans_checked',
    'identities_checked',
    'media_checked',
    'invalidated',
    'stopped',
  ]),
});

/** Atomic scan/checkpoint commits; plans_checked still requires identity/media validation and approval. */
export async function runImportDryRunRecordBatch(
  deps: { db: Db; jobId: string },
  raw: z.input<typeof requestSchema>,
) {
  const request = requestSchema.parse(raw);
  const { claim } = request;
  const scope = { brandId: claim.brandId, runId: claim.runId };
  if (claim.phase !== 'dry_run') throw new ImportClaimLost();
  try {
    return await withSystemJob(deps.db, claim.brandId, deps.jobId, async (tx) => {
      await renewImportClaim(tx, claim);
      const predicate = and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId));
      const [run] = await tx.select().from(importRuns).where(predicate);
      if (!run) throw new ImportClaimLost();
      if (
        run.dryRunReport &&
        z.object({ version: z.literal(1) }).safeParse(run.dryRunReport).success
      ) {
        await tx
          .update(importRuns)
          .set({
            dryRunReport: null,
            status: 'awaiting_mapping',
            claimToken: null,
            claimedAt: null,
          })
          .where(predicate);
        return resultSchema.parse({ state: 'invalidated' });
      }
      if (!run.dryRunReport)
        await tx
          .update(importRecords)
          .set({ dryRunIdentity: null, dryRunMedia: null })
          .where(
            and(eq(importRecords.brandId, claim.brandId), eq(importRecords.runId, claim.runId)),
          );
      const prior = importDryRunCheckpointSchema.parse(
        run.dryRunReport ?? {
          version: 2,
          phase: 'records',
          fingerprint: await importInputFingerprint(tx, scope),
          destinationFingerprint: await importDestinationFingerprint(tx, scope),
          defaultCallingCode: request.defaultCallingCode,
          after: null,
          checked: 0,
          issueCount: 0,
          issues: [],
          ...(run.source === 'file'
            ? await importFileSourceWarnings(tx, {
                ...scope,
                entities: importScopeSchema.parse({
                  entities: run.options.entities,
                  rebuildAllReports: run.options.rebuildAllReports,
                }).entities,
              })
            : await importVendorSourceWarnings(tx, {
                ...scope,
                entities: importScopeSchema.parse({
                  entities: run.options.entities,
                  rebuildAllReports: run.options.rebuildAllReports,
                }).entities,
              })),
        },
      );
      if (prior.defaultCallingCode !== request.defaultCallingCode)
        throw new ImportLoadError('mapping-invalid');
      if (prior.phase === 'plans_checked') {
        const identities = await validateImportIdentityPlan(tx, { ...scope, source: run.source });
        const phase =
          (await importInputFingerprint(tx, scope)) === prior.fingerprint
            ? 'identities_checked'
            : 'invalidated';
        await storeImportDryRunCheckpoint(
          tx,
          claim,
          importDryRunCheckpointSchema.parse({
            ...prior,
            phase,
            identityIssueCount: identities.issueCount,
            identityIssues: identities.issues,
          }),
        );
        return resultSchema.parse({ state: phase });
      }
      if (prior.phase === 'records_checked') {
        const plan = await validateImportMappingPlan(tx, { ...scope, source: run.source });
        const phase =
          (await importInputFingerprint(tx, scope)) === prior.fingerprint
            ? 'plans_checked'
            : 'invalidated';
        const checkpoint = importDryRunCheckpointSchema.parse({
          ...prior,
          phase,
          mappingsChecked: plan.checked,
          planIssueCount: plan.issueCount,
          planIssues: plan.issues,
        });
        await storeImportDryRunCheckpoint(tx, claim, checkpoint);
        return resultSchema.parse({ state: phase });
      }
      if (prior.phase !== 'records') return resultSchema.parse({ state: prior.phase });
      const page = await validateImportRecordPage(tx, {
        brandId: claim.brandId,
        runId: claim.runId,
        source: run.source,
        after: prior.after,
        batchSize: request.batchSize,
        defaultCallingCode: prior.defaultCallingCode,
      });
      for (const planned of page.identityPlans) {
        await tx
          .update(importRecords)
          .set({ dryRunIdentity: planned.projection })
          .where(
            and(
              eq(importRecords.brandId, claim.brandId),
              eq(importRecords.runId, claim.runId),
              eq(importRecords.id, planned.recordId),
              eq(importRecords.payloadHash, planned.projection.inputHash),
            ),
          );
      }
      const phase = page.next
        ? 'records'
        : (await importInputFingerprint(tx, scope)) === prior.fingerprint
          ? 'records_checked'
          : 'invalidated';
      const checkpoint = importDryRunCheckpointSchema.parse({
        ...prior,
        phase,
        after: page.next,
        checked: prior.checked + page.checked,
        issueCount: prior.issueCount + page.issueCount,
        recordWarningCount: prior.recordWarningCount + page.warningCount,
        recordWarnings: [...prior.recordWarnings, ...page.warnings].slice(0, 100),
        refusedPhones: prior.refusedPhones + page.refusedPhones,
        issues: [...prior.issues, ...page.issues].slice(0, 100),
      });
      await storeImportDryRunCheckpoint(tx, claim, checkpoint);
      return resultSchema.parse({ state: phase === 'records' ? 'more' : phase });
    });
  } catch (error) {
    if (!(error instanceof ImportClaimLost)) throw error;
    return resultSchema.parse({ state: 'stopped' });
  }
}

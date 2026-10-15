import { brands, type Db, type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { type Connector, type ConnectorContext, hashImportValue } from '@helpdock/importers';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { readContentPolicy } from '../../media/content-policy.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportLoadError } from '../loader/contracts.js';
import { validatedStagedRecord } from '../preflight/staged-record.js';
import {
  type ImportClaim,
  ImportClaimLost,
  importClaimSchema,
  renewImportClaim,
} from './claims.js';
import { importDryRunCheckpointSchema, storeImportDryRunCheckpoint } from './dry-run-state.js';
import { importInputFingerprint } from './input-fingerprint.js';
import { inspectDryRunFile } from './inspect-dry-run-file.js';

const resultSchema = z.strictObject({
  state: z.enum(['more', 'media_checked', 'invalidated', 'stopped']),
  checked: z.int().min(0).max(1),
});

async function mediaRun(tx: DbTransaction, claim: ImportClaim) {
  await renewImportClaim(tx, claim);
  const [selected] = await tx
    .select({ run: importRuns, settings: brands.settings })
    .from(importRuns)
    .innerJoin(brands, eq(brands.id, importRuns.brandId))
    .where(and(eq(importRuns.brandId, claim.brandId), eq(importRuns.id, claim.runId)));
  if (!selected) throw new ImportClaimLost();
  const checkpoint = importDryRunCheckpointSchema.parse(selected.run.dryRunReport);
  const policy = readContentPolicy(selected.settings.contentPolicy);
  return { run: selected.run, checkpoint, policy, policyHash: hashImportValue(policy) };
}

async function invalidateMedia(
  tx: DbTransaction,
  claim: ImportClaim,
  checkpoint: z.infer<typeof importDryRunCheckpointSchema>,
) {
  await storeImportDryRunCheckpoint(tx, claim, { ...checkpoint, phase: 'invalidated' });
  return resultSchema.parse({ state: 'invalidated', checked: 0 });
}

/** One bounded download outside transactions; publication checks the claim, cursor, payload and policy again. */
export async function runImportDryRunMediaBatch<C>(
  deps: { db: Db; jobId: string; connector: Connector<C>; context: ConnectorContext<C> },
  raw: ImportClaim,
) {
  const claim = importClaimSchema.parse(raw);
  if (claim.phase !== 'dry_run') throw new ImportClaimLost();
  const scope = { brandId: claim.brandId, runId: claim.runId };
  const inRun = <T>(work: (tx: DbTransaction) => Promise<T>) =>
    withSystemJob(deps.db, claim.brandId, deps.jobId, work);
  try {
    const selected = await inRun(async (tx) => {
      const { run, checkpoint, policy, policyHash } = await mediaRun(tx, claim);
      if (run.source !== deps.connector.source) throw new ImportLoadError('mapping-invalid');
      if (checkpoint.mediaPolicyHash && checkpoint.mediaPolicyHash !== policyHash)
        return invalidateMedia(tx, claim, checkpoint);
      if (checkpoint.phase === 'media_checked')
        return resultSchema.parse({ state: 'media_checked', checked: 0 });
      if (checkpoint.phase !== 'identities_checked') throw new ImportLoadError('mapping-invalid');
      if (
        !checkpoint.mediaPolicyHash &&
        (await importInputFingerprint(tx, scope)) !== checkpoint.fingerprint
      )
        return invalidateMedia(tx, claim, checkpoint);
      const [row] = await tx
        .select()
        .from(importRecords)
        .where(
          and(
            eq(importRecords.brandId, claim.brandId),
            eq(importRecords.runId, claim.runId),
            eq(importRecords.entity, 'attachment'),
            checkpoint.mediaAfter ? gt(importRecords.id, checkpoint.mediaAfter) : undefined,
          ),
        )
        .orderBy(importRecords.id)
        .limit(1);
      if (!row) {
        if ((await importInputFingerprint(tx, scope)) !== checkpoint.fingerprint)
          return invalidateMedia(tx, claim, checkpoint);
        await storeImportDryRunCheckpoint(tx, claim, {
          ...checkpoint,
          phase: 'media_checked',
          mediaPolicyHash: policyHash,
        });
        return resultSchema.parse({ state: 'media_checked', checked: 0 });
      }
      const native = validatedStagedRecord(row);
      if (native.entity !== 'attachment') throw new ImportLoadError('mapping-invalid');
      const { ticketExternalId: _ticket, messageExternalId: _message, ...ref } = native.payload;
      await storeImportDryRunCheckpoint(tx, claim, { ...checkpoint, mediaPolicyHash: policyHash });
      return { row, ref, policy, policyHash, after: checkpoint.mediaAfter };
    });
    if ('state' in selected) return selected;
    const outcome = await inspectDryRunFile(deps, { ref: selected.ref, policy: selected.policy });
    return await inRun(async (tx) => {
      const { checkpoint, policyHash } = await mediaRun(tx, claim);
      if (checkpoint.phase === 'media_checked')
        return resultSchema.parse({ state: 'media_checked', checked: 0 });
      if (checkpoint.phase !== 'identities_checked') throw new ImportLoadError('mapping-invalid');
      if (checkpoint.mediaAfter !== selected.after)
        return resultSchema.parse({ state: 'more', checked: 0 });
      const [current] = await tx
        .select({ hash: importRecords.payloadHash })
        .from(importRecords)
        .where(
          and(
            eq(importRecords.brandId, claim.brandId),
            eq(importRecords.runId, claim.runId),
            eq(importRecords.id, selected.row.id),
          ),
        );
      if (current?.hash !== selected.row.payloadHash || policyHash !== selected.policyHash)
        return invalidateMedia(tx, claim, checkpoint);
      const issue =
        outcome.state === 'available'
          ? []
          : [
              {
                entity: 'attachment' as const,
                externalId: selected.row.externalId,
                code: outcome.code,
                level: outcome.state,
              },
            ];
      await storeImportDryRunCheckpoint(
        tx,
        claim,
        importDryRunCheckpointSchema.parse({
          ...checkpoint,
          mediaAfter: selected.row.id,
          mediaChecked: checkpoint.mediaChecked + 1,
          mediaWarnings: checkpoint.mediaWarnings + (outcome.state === 'warning' ? 1 : 0),
          mediaErrors: checkpoint.mediaErrors + (outcome.state === 'error' ? 1 : 0),
          mediaIssues: [...checkpoint.mediaIssues, ...issue].slice(0, 100),
        }),
      );
      return resultSchema.parse({ state: 'more', checked: 1 });
    });
  } catch (error) {
    if (!(error instanceof ImportClaimLost)) throw error;
    return resultSchema.parse({ state: 'stopped', checked: 0 });
  }
}

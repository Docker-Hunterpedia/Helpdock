import { brands, type Db, type DbTransaction, importRecords, importRuns } from '@helpdock/db';
import { type Connector, type ConnectorContext, hashImportValue } from '@helpdock/importers';
import type { ImportRecord } from '@helpdock/schemas';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { readContentPolicy } from '../../media/content-policy.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { importArticleAssetRequests } from '../article-asset-requests.js';
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
import { inspectDryRunArticleAsset } from './inspect-dry-run-article-asset.js';
import { inspectDryRunFile } from './inspect-dry-run-file.js';
import { importMediaInspectionSchema } from './media-inspection.js';

const resultSchema = z.strictObject({
  state: z.enum(['more', 'media_checked', 'invalidated', 'stopped']),
  checked: z.int().min(0).max(1),
});

function attachmentReference(payload: Extract<ImportRecord, { entity: 'attachment' }>['payload']) {
  const { ticketExternalId: _ticket, messageExternalId: _message, ...ref } = payload;
  return ref;
}

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
            inArray(importRecords.entity, ['attachment', 'article']),
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
      if (native.entity !== 'attachment' && native.entity !== 'article')
        throw new ImportLoadError('mapping-invalid');
      const assets =
        native.entity === 'article'
          ? importArticleAssetRequests(native.payload, claim.brandId, run.source)
          : [];
      const asset = assets[checkpoint.mediaAssetIndex];
      if (native.entity === 'article' && !asset) {
        if (checkpoint.mediaAssetIndex !== 0) throw new ImportLoadError('mapping-invalid');
        await storeImportDryRunCheckpoint(tx, claim, {
          ...checkpoint,
          mediaAfter: row.id,
          mediaAssetIndex: 0,
          mediaPolicyHash: policyHash,
        });
        return resultSchema.parse({ state: 'more', checked: 0 });
      }
      const ref = native.entity === 'attachment' ? attachmentReference(native.payload) : undefined;
      if (ref && checkpoint.mediaAssetIndex !== 0) throw new ImportLoadError('mapping-invalid');
      await storeImportDryRunCheckpoint(tx, claim, { ...checkpoint, mediaPolicyHash: policyHash });
      return {
        row,
        ref,
        asset,
        policy,
        policyHash,
        after: checkpoint.mediaAfter,
        index: checkpoint.mediaAssetIndex,
        count: Math.max(1, assets.length),
        entity: native.entity,
      };
    });
    if ('state' in selected) return selected;
    const outcome = selected.asset
      ? await inspectDryRunArticleAsset(deps, { asset: selected.asset, policy: selected.policy })
      : selected.ref
        ? await inspectDryRunFile(deps, { ref: selected.ref, policy: selected.policy })
        : undefined;
    if (!outcome) throw new ImportLoadError('mapping-invalid');
    return await inRun(async (tx) => {
      const { checkpoint, policyHash } = await mediaRun(tx, claim);
      if (checkpoint.phase === 'media_checked')
        return resultSchema.parse({ state: 'media_checked', checked: 0 });
      if (checkpoint.phase !== 'identities_checked') throw new ImportLoadError('mapping-invalid');
      if (checkpoint.mediaAfter !== selected.after || checkpoint.mediaAssetIndex !== selected.index)
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
      if (selected.entity === 'attachment')
        await tx
          .update(importRecords)
          .set({
            dryRunMedia: importMediaInspectionSchema.parse({
              version: 1,
              fingerprint: checkpoint.fingerprint,
              payloadHash: selected.row.payloadHash,
              policyHash,
              outcome,
            }),
          })
          .where(
            and(
              eq(importRecords.brandId, claim.brandId),
              eq(importRecords.runId, claim.runId),
              eq(importRecords.id, selected.row.id),
            ),
          );
      const issue =
        outcome.state === 'available'
          ? []
          : [
              {
                entity: selected.entity,
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
          mediaAfter: selected.index + 1 < selected.count ? selected.after : selected.row.id,
          mediaAssetIndex: selected.index + 1 < selected.count ? selected.index + 1 : 0,
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

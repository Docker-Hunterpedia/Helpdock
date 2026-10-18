import { type Db, type DbTransaction, importPages } from '@helpdock/db';
import {
  hashImportValue,
  type ImportPageCache,
  type ImportSnapshotScope,
} from '@helpdock/importers';
import type { SafeFetchResponse } from '@helpdock/net';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { type ImportClaim, renewImportClaim } from './claims.js';

const responseSchema = z.strictObject({
  status: z.int().min(200).max(299),
  body: z.string().max(Math.ceil((50 * 1024 * 1024) / 3) * 4),
  url: z.url(),
  redirects: z.array(z.url()).max(10),
  headers: z.partialRecord(
    z.enum(['link', 'content-type']),
    z.union([z.string(), z.array(z.string())]),
  ),
});

function restored(raw: unknown): SafeFetchResponse {
  const response = responseSchema.parse(raw);
  return { ...response, body: Buffer.from(response.body, 'base64') };
}

const slotSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);

type Scope = ImportSnapshotScope | undefined;

/** A slot follows its latest request; a run-scoped snapshot never shrinks back into a slot. */
async function retain(tx: DbTransaction, claim: ImportClaim, hash: string, scope: Scope) {
  if (!scope) return;
  const run = and(eq(importPages.brandId, claim.brandId), eq(importPages.runId, claim.runId));
  const page = and(run, eq(importPages.requestHash, hash));
  if ('run' in scope) {
    await tx.update(importPages).set({ runScoped: true, slot: null }).where(page);
    return;
  }
  const slot = slotSchema.parse(scope.slot);
  await tx
    .update(importPages)
    .set({ slot: null })
    .where(and(run, eq(importPages.slot, slot), ne(importPages.requestHash, hash)));
  await tx
    .update(importPages)
    .set({ slot })
    .where(and(page, eq(importPages.runScoped, false)));
}

/**
 * Called with the checkpoint that consumed them: only slotted and run-scoped snapshots can
 * still be read by a resume, and a finished entity leaves only run-scoped ones behind.
 */
export async function discardConsumedImportPages(
  tx: DbTransaction,
  claim: ImportClaim,
  entityDone: boolean,
) {
  await tx
    .delete(importPages)
    .where(
      and(
        eq(importPages.brandId, claim.brandId),
        eq(importPages.runId, claim.runId),
        eq(importPages.runScoped, false),
        entityDone ? undefined : isNull(importPages.slot),
      ),
    );
}

/** Persist before yielding records: retries read the same page, not a moving vendor tail. */
export function importExtractionPageCache(
  db: Db,
  claim: ImportClaim,
  jobId: string,
): ImportPageCache {
  const key = (hash: string) =>
    and(
      eq(importPages.brandId, claim.brandId),
      eq(importPages.runId, claim.runId),
      eq(importPages.requestHash, hash),
    );
  const stored = async (tx: DbTransaction, hash: string, scope: Scope) => {
    const [page] = await tx
      .select({ response: importPages.response })
      .from(importPages)
      .where(key(hash));
    if (page) await retain(tx, claim, hash, scope);
    return page ? restored(page.response) : undefined;
  };
  return {
    read: (url, scope) =>
      withSystemJob(db, claim.brandId, jobId, async (tx) => {
        await renewImportClaim(tx, claim);
        return stored(tx, hashImportValue(url), scope);
      }),
    write: (url, response, scope) =>
      withSystemJob(db, claim.brandId, jobId, async (tx) => {
        await renewImportClaim(tx, claim);
        const headers = Object.fromEntries(
          Object.entries(response.headers).filter(([name]) =>
            ['link', 'content-type'].includes(name),
          ),
        );
        const payload = responseSchema.parse({
          ...response,
          body: response.body.toString('base64'),
          headers,
        });
        const hash = hashImportValue(url);
        await tx
          .insert(importPages)
          .values({
            brandId: claim.brandId,
            runId: claim.runId,
            requestHash: hash,
            response: payload,
          })
          .onConflictDoNothing();
        const page = await stored(tx, hash, scope);
        if (!page) throw new Error('import.page-snapshot-missing');
        return page;
      }),
  };
}

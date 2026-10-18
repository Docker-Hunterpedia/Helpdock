import { type Db, importPages } from '@helpdock/db';
import { hashImportValue, type ImportPageCache } from '@helpdock/importers';
import type { SafeFetchResponse } from '@helpdock/net';
import { and, eq } from 'drizzle-orm';
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

/** Persist before yielding records: retries read the same page, not a moving vendor tail. */
export function importExtractionPageCache(
  db: Db,
  claim: ImportClaim,
  jobId: string,
): ImportPageCache {
  const key = (url: string) =>
    and(
      eq(importPages.brandId, claim.brandId),
      eq(importPages.runId, claim.runId),
      eq(importPages.requestHash, hashImportValue(url)),
    );
  return {
    read: (url) =>
      withSystemJob(db, claim.brandId, jobId, async (tx) => {
        await renewImportClaim(tx, claim);
        const [page] = await tx
          .select({ response: importPages.response })
          .from(importPages)
          .where(key(url));
        return page ? restored(page.response) : undefined;
      }),
    write: (url, response) =>
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
        await tx
          .insert(importPages)
          .values({
            brandId: claim.brandId,
            runId: claim.runId,
            requestHash: hashImportValue(url),
            response: payload,
          })
          .onConflictDoNothing();
        const [page] = await tx
          .select({ response: importPages.response })
          .from(importPages)
          .where(key(url));
        if (!page) throw new Error('import.page-snapshot-missing');
        return restored(page.response);
      }),
  };
}

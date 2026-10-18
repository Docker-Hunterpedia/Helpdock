import { decryptSecret, encryptSecret, type Keyring } from '@helpdock/config';
import { type Db, importRuns } from '@helpdock/db';
import { ConnectorError, hashImportValue, zohoAccessTokenSchema } from '@helpdock/importers';
import { zohoCredentialsSchema } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withSystemJob } from '../../tenant/system-job.js';
import { importClaimSchema, renewImportClaim } from './claims.js';
import { sourceAccountKey } from './source-account.js';

const storedCredentialsSchema = zohoCredentialsSchema.extend({
  accessToken: zohoAccessTokenSchema.optional(),
});

export function decodedZohoCredentials(raw: unknown) {
  const parsed = storedCredentialsSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError('credentials-refused');
  const { accessToken, ...credentials } = parsed.data;
  return { credentials, accessToken };
}

function storedZohoCredentials(encrypted: string, keyring: Keyring) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decryptSecret(encrypted, keyring));
  } catch {
    throw new ConnectorError('credentials-refused');
  }
  return decodedZohoCredentials(decoded);
}

const saveSchema = z.strictObject({
  claim: importClaimSchema,
  credentials: zohoCredentialsSchema,
  accessToken: zohoAccessTokenSchema,
});
/** The same run blob is purged on terminal transitions; a stale refresh cannot resurrect it. */
export async function saveZohoAccessToken(
  deps: { db: Db; keyring: Keyring },
  raw: z.infer<typeof saveSchema>,
): Promise<void> {
  const request = saveSchema.parse(raw);
  await withSystemJob(deps.db, request.claim.brandId, 'import.connection', async (tx) => {
    await renewImportClaim(tx, request.claim);
    const predicate = and(
      eq(importRuns.brandId, request.claim.brandId),
      eq(importRuns.id, request.claim.runId),
      eq(importRuns.source, 'zohodesk'),
    );
    const [run] = await tx
      .select({
        credentials: importRuns.credentialsEncrypted,
        accountKey: importRuns.sourceAccountKey,
      })
      .from(importRuns)
      .where(predicate);
    if (!run?.credentials) throw new ConnectorError('credentials-refused');
    const stored = storedZohoCredentials(run.credentials, deps.keyring);
    if (
      hashImportValue(stored.credentials) !== hashImportValue(request.credentials) ||
      run.accountKey !==
        sourceAccountKey({
          source: 'zohodesk',
          verifiedAccount: `${stored.credentials.region}:${stored.credentials.orgId}`,
        })
    )
      throw new ConnectorError('credentials-refused');
    await tx
      .update(importRuns)
      .set({
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ ...stored.credentials, accessToken: request.accessToken }),
          deps.keyring,
        ),
      })
      .where(predicate);
  });
}

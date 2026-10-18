import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type Connector, type ConnectorContext, ConnectorError } from '@helpdock/importers';
import { HC_IMAGE_MAX_BYTES } from '@helpdock/schemas';
import { PolicyRefusal } from '../../media/content-policy.js';
import type { ObjectStorage } from '../../media/storage.js';
import type { ImportArticleAssetRequest } from '../article-asset-requests.js';
import {
  type ImportArticleAssetOutcome,
  importArticleAssetRefusalSchema,
} from '../article-asset-state.js';
import { ImportLoadError } from '../loader/contracts.js';
import {
  type ArticlePreparationSnapshot,
  readArticlePreparation,
  saveArticlePreparation,
} from './article-asset-checkpoint.js';
import { publishArticleAsset, reserveArticleAsset } from './article-asset-register.js';
import { readArticleAssetSource } from './article-asset-source.js';
import {
  type ArticlePreparationTransaction,
  logUnavailableArticleAsset,
} from './article-preparation-work.js';
import { type PreparedImportFile, withPreparedImportFile } from './prepare-file.js';

type Connection<C> = { connector: Connector<C>; context: ConnectorContext<C> };
type Download<C> = {
  snapshot: ArticlePreparationSnapshot;
  request: ImportArticleAssetRequest;
  connection: Connection<C>;
  storage: ObjectStorage;
  inRun: ArticlePreparationTransaction;
};

async function storePreparedFile<C>(work: Download<C>, file: PreparedImportFile) {
  const { request, snapshot, inRun, storage } = work;
  if (request.identity.size !== undefined && request.identity.size !== file.size)
    throw new ImportLoadError('mapping-invalid');
  if (request.usage === 'image' && file.kind !== 'image') throw new PolicyRefusal('mime_mismatch');
  if (file.kind === 'image' && file.size > HC_IMAGE_MAX_BYTES) throw new PolicyRefusal('too_large');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file.path)) digest.update(bytes);
  const contentHash = digest.digest('hex');
  const reserved = await inRun((tx) =>
    reserveArticleAsset(tx, { input: snapshot.input, request, file, contentHash }),
  );
  if (reserved.state === 'existing') return;
  await storage.upload({ key: reserved.key, path: file.path, contentType: file.mime });
  await inRun((tx) => publishArticleAsset(tx, snapshot.input, request, reserved));
}

function sourceRefusal(error: unknown, key: string): ImportArticleAssetOutcome {
  if (error instanceof ConnectorError && error.code === 'record-unavailable')
    return { key, state: 'unavailable', reason: 'source-unavailable' };
  if (error instanceof PolicyRefusal) {
    const reason = importArticleAssetRefusalSchema.safeParse(error.reason);
    if (reason.success) return { key, state: 'unavailable', reason: reason.data };
  }
  throw error;
}

/** Storage and infrastructure failures propagate; only explicit source/policy refusals become placeholders. */
export async function downloadArticleAsset<C>(work: Download<C>): Promise<void> {
  const { request, connection, snapshot, inRun } = work;
  if (connection.connector.source !== snapshot.source) throw new ImportLoadError('mapping-invalid');
  const context = {
    ...connection.context,
    credentials: connection.connector.credentialsSchema.parse(connection.context.credentials),
  };
  let refused: ImportArticleAssetOutcome;
  try {
    const source = await readArticleAssetSource({ ...connection, context }, request);
    await withPreparedImportFile(
      {
        stream: source.stream,
        policy: snapshot.policy,
        signal: context.signal,
        contentType: request.identity.contentType ?? source.contentType,
        declaredSize: request.identity.size ?? source.size,
      },
      (file) => storePreparedFile(work, file),
    );
    return;
  } catch (error) {
    refused = sourceRefusal(error, request.key);
  }
  await inRun(async (tx) => {
    const current = await readArticlePreparation(tx, snapshot.input);
    await saveArticlePreparation(tx, snapshot.input, {
      ...current.preparation,
      outcomes: [...current.preparation.outcomes, refused],
    });
    await logUnavailableArticleAsset(tx, snapshot.input);
  });
}

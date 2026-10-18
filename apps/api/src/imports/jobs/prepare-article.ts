import type { Db } from '@helpdock/db';
import type { Connector, ConnectorContext } from '@helpdock/importers';
import type { ObjectStorage } from '../../media/storage.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { ImportArticleAssetsPending } from '../article-asset-state.js';
import type { PreparedImportArticle } from '../article-prepared.js';
import {
  type ArticlePreparationRequest,
  articlePreparationRequestSchema,
  readArticlePreparation,
} from './article-asset-checkpoint.js';
import {
  type ArticleMediaJobState,
  advanceArticleAsset,
  sealPreparedArticle,
} from './article-asset-completion.js';
import { downloadArticleAsset } from './article-asset-download.js';
import type { ArticlePreparationTransaction } from './article-preparation-work.js';

type Dependencies<C> = {
  db: Db;
  storage: ObjectStorage;
  resolve: (scope: {
    brandId: string;
    runId: string;
  }) => Promise<{ connector: Connector<C>; context: ConnectorContext<C> }>;
  /** Undefined means the outbox may still be delivering the job; terminal states are actual Bull state. */
  mediaJobState: ArticleMediaJobState;
};

/** One file per continuation keeps memory bounded and checkpoints progress before waiting for media. */
export function createImportArticlePreparer<C>(deps: Dependencies<C>) {
  return async (raw: ArticlePreparationRequest): Promise<string | PreparedImportArticle> => {
    const input = articlePreparationRequestSchema.parse(raw);
    const inRun: ArticlePreparationTransaction = (work) =>
      withSystemJob(deps.db, input.claim.brandId, 'import.article.prepare', work);
    const snapshot = await inRun((tx) => readArticlePreparation(tx, input));
    const saved = new Set(snapshot.preparation.outcomes.map((outcome) => outcome.key));
    const request = snapshot.requests.find((request) => !saved.has(request.key));
    if (request) {
      await downloadArticleAsset({
        snapshot,
        request,
        inRun,
        storage: deps.storage,
        connection: await deps.resolve({
          brandId: input.claim.brandId,
          runId: input.claim.runId,
        }),
      });
      throw new ImportArticleAssetsPending();
    }
    await advanceArticleAsset(snapshot, inRun, deps.mediaJobState);
    return sealPreparedArticle(snapshot, inRun);
  };
}

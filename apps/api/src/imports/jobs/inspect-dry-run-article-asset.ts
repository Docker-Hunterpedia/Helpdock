import type { Connector, ConnectorContext } from '@helpdock/importers';
import { ConnectorError } from '@helpdock/importers';
import { SafeFetchError } from '@helpdock/net';
import { type ContentPolicy, HC_IMAGE_MAX_BYTES } from '@helpdock/schemas';
import { PolicyRefusal } from '../../media/content-policy.js';
import type { ImportArticleAssetRequest } from '../article-asset-requests.js';
import { readArticleAssetSource } from './article-asset-source.js';
import { withPreparedImportFile } from './prepare-file.js';

/** Reads one bounded source file, without uploading objects or creating domain/media work. */
export async function inspectDryRunArticleAsset<C>(
  deps: { connector: Connector<C>; context: ConnectorContext<C> },
  request: { asset: ImportArticleAssetRequest; policy: ContentPolicy },
) {
  const { asset } = request;
  try {
    const context = {
      ...deps.context,
      credentials: deps.connector.credentialsSchema.parse(deps.context.credentials),
    };
    const source = await readArticleAssetSource({ ...deps, context }, asset);
    return await withPreparedImportFile(
      {
        stream: source.stream,
        policy: request.policy,
        signal: context.signal,
        contentType: asset.identity.contentType ?? source.contentType,
        declaredSize: asset.identity.size ?? source.size,
      },
      async (file) => {
        if (asset.identity.size !== undefined && file.size !== asset.identity.size)
          return { state: 'error' as const, code: 'media-size-mismatch' };
        if (asset.usage === 'image' && file.kind !== 'image')
          throw new PolicyRefusal('mime_mismatch');
        if (file.kind === 'image' && file.size > HC_IMAGE_MAX_BYTES)
          throw new PolicyRefusal('too_large');
        return { state: 'available' as const, size: file.size, mime: file.mime };
      },
    );
  } catch (error) {
    if (error instanceof ConnectorError && error.code === 'record-unavailable')
      return { state: 'warning' as const, code: 'media-unavailable' };
    if (error instanceof PolicyRefusal)
      return { state: 'error' as const, code: `media-${error.reason}` };
    if (error instanceof SafeFetchError)
      return { state: 'error' as const, code: 'media-unreachable' };
    throw error;
  }
}

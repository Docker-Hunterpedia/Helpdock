import { Readable } from 'node:stream';
import { type Connector, type ConnectorContext, ConnectorError } from '@helpdock/importers';
import type { ImportArticleAssetRequest } from '../article-asset-requests.js';

async function unauthenticatedArticleImage<C>(context: ConnectorContext<C>, url: string) {
  try {
    return await context.http.request(url, { signal: context.signal });
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      error.code === 'credentials-refused' &&
      [401, 403].includes(error.status ?? 0)
    )
      throw new ConnectorError('record-unavailable', error.status, error.responseOrigin);
    throw error;
  }
}

/** Native references use the vendor adapter; synthetic remote images never receive vendor credentials. */
export async function readArticleAssetSource<C>(
  connection: { connector: Connector<C>; context: ConnectorContext<C> },
  request: ImportArticleAssetRequest,
) {
  if (request.input.kind === 'inline')
    return {
      stream: Readable.from([Buffer.from(request.input.base64, 'base64')]),
      contentType: request.input.mime,
      size: request.identity.size,
    };
  const ref = request.input.ref;
  if (ref.externalId.startsWith('inline:') && ref.url) {
    const response = await unauthenticatedArticleImage(connection.context, ref.url);
    const type = response.headers['content-type'];
    return {
      stream: Readable.from([response.body]),
      contentType: Array.isArray(type) ? type[0] : type,
      size: response.body.length,
    };
  }
  return connection.connector.fetchAttachment(connection.context, ref);
}

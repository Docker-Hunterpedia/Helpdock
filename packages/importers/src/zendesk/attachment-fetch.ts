import { Readable } from 'node:stream';
import type { ImportAttachmentRef } from '@helpdock/schemas';
import { z } from 'zod';
import type { ConnectorContext } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { ZendeskClient } from './client.js';
import { type ZendeskCredentials, zendeskAttachmentSchema } from './contracts.js';

const attachmentIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.int().positive());

function unavailableAsset(error: unknown, accountOrigin: string) {
  return (
    error instanceof ConnectorError &&
    (error.code === 'record-unavailable' ||
      (error.code === 'credentials-refused' &&
        error.responseOrigin !== undefined &&
        error.responseOrigin !== accountOrigin))
  );
}

/** Refresh once through authenticated metadata; external asset requests never carry account credentials. */
export async function fetchZendeskAttachment(
  context: ConnectorContext<ZendeskCredentials>,
  client: ZendeskClient,
  ref: ImportAttachmentRef,
) {
  const download = (url: string) =>
    context.http.request(
      url,
      new URL(url).origin === client.origin ? client.init() : { signal: context.signal },
    );
  if (!ref.url) throw new ConnectorError('invalid-response');
  let response: Awaited<ReturnType<typeof download>>;
  try {
    response = await download(ref.url);
  } catch (error) {
    if (!unavailableAsset(error, client.origin)) throw error;
    const id = attachmentIdSchema.safeParse(ref.externalId);
    if (!id.success) throw new ConnectorError('record-unavailable');
    const resource = await client.json(
      `/api/v2/attachments/${id.data}`,
      z.object({ attachment: zendeskAttachmentSchema }),
    );
    if (resource.attachment.id !== id.data) throw new ConnectorError('invalid-response');
    try {
      response = await download(resource.attachment.content_url);
    } catch (retry) {
      if (unavailableAsset(retry, client.origin)) throw new ConnectorError('record-unavailable');
      throw retry;
    }
  }
  const contentType = response.headers['content-type'];
  return {
    stream: Readable.from(response.body),
    size: response.body.length,
    ...(typeof contentType === 'string' ? { contentType } : {}),
  };
}

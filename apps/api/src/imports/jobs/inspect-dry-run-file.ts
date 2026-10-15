import type { Connector, ConnectorContext } from '@helpdock/importers';
import { ConnectorError } from '@helpdock/importers';
import { SafeFetchError } from '@helpdock/net';
import type { ContentPolicy, ImportAttachmentRef } from '@helpdock/schemas';
import { z } from 'zod';
import { PolicyRefusal } from '../../media/content-policy.js';
import { withPreparedImportFile } from './prepare-file.js';

const outcomeSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('available'),
    size: z.int().positive(),
    mime: z.string().max(255),
  }),
  z.strictObject({ state: z.enum(['warning', 'error']), code: z.string().min(1).max(100) }),
]);

/** Inspect bounded bytes in a temporary file; no objects, attachment rows or media jobs are created. */
export async function inspectDryRunFile<C>(
  deps: { connector: Connector<C>; context: ConnectorContext<C> },
  request: { ref: ImportAttachmentRef; policy: ContentPolicy },
) {
  try {
    const context = {
      ...deps.context,
      credentials: deps.connector.credentialsSchema.parse(deps.context.credentials),
    };
    const downloaded = await deps.connector.fetchAttachment(context, request.ref);
    const contentType = request.ref.contentType ?? downloaded.contentType;
    const declaredSize = downloaded.size;
    return await withPreparedImportFile(
      {
        stream: downloaded.stream,
        policy: request.policy,
        signal: context.signal,
        ...(contentType === undefined ? {} : { contentType }),
        ...(declaredSize === undefined ? {} : { declaredSize }),
      },
      async (file) => outcomeSchema.parse({ state: 'available', size: file.size, mime: file.mime }),
    );
  } catch (error) {
    if (error instanceof ConnectorError && error.code === 'record-unavailable')
      return outcomeSchema.parse({ state: 'warning', code: 'media-unavailable' });
    if (error instanceof PolicyRefusal)
      return outcomeSchema.parse({ state: 'error', code: `media-${error.reason}` });
    if (error instanceof SafeFetchError)
      return outcomeSchema.parse({ state: 'error', code: 'media-unreachable' });
    throw error;
  }
}

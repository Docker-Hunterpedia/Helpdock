import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { ZendeskClient } from './client.js';
import { zendeskOrganizationSchema, zendeskTimeEnvelopeSchema } from './contracts.js';
import { zendeskOrganizationRecord } from './records.js';

const cursorSchema = z
  .strictObject({
    startTime: z.int().nonnegative(),
    offset: z.int().nonnegative().default(0),
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((cursor) => cursor.offset === 0 || cursor.fingerprint !== undefined);
const pageSchema = zendeskTimeEnvelopeSchema.extend({
  // Time-based exports can exceed their page target to retain a timestamp tie.
  organizations: z.array(zendeskOrganizationSchema).max(100000),
});

/** Vendor pages retain their exact time watermark; only local staging chunks are capped at 1,000. */
export async function* exportZendeskOrganizations(
  client: ZendeskClient,
  cursor: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let checkpoint = cursorSchema.parse(
    cursor ?? { startTime: since ? Math.max(0, Math.floor(since.getTime() / 1000)) : 0 },
  );
  while (true) {
    const page = await client.json(
      '/api/v2/incremental/organizations.json',
      pageSchema,
      { start_time: String(checkpoint.startTime) },
      { slot: 'zendesk.organizations' },
    );
    const fingerprint = hashImportValue(page.organizations);
    if (
      (checkpoint.fingerprint && checkpoint.fingerprint !== fingerprint) ||
      checkpoint.offset > page.organizations.length ||
      page.end_time < checkpoint.startTime ||
      (!page.end_of_stream && page.end_time === checkpoint.startTime)
    )
      throw new ConnectorError('invalid-response');
    for (let offset = checkpoint.offset; offset < page.organizations.length; offset += 1000) {
      const chunk = page.organizations.slice(offset, offset + 1000);
      yield {
        records: chunk.map(zendeskOrganizationRecord),
        cursor: { startTime: checkpoint.startTime, offset: offset + chunk.length, fingerprint },
      };
    }
    const next = { startTime: page.end_time };
    yield {
      records: [],
      cursor: page.end_of_stream ? null : next,
      ...(page.end_of_stream ? { deltaCursor: next } : {}),
    };
    if (page.end_of_stream) return;
    checkpoint = cursorSchema.parse(next);
  }
}

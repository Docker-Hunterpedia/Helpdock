import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { ZendeskClient } from './client.js';
import {
  zendeskCursorEnvelopeSchema,
  zendeskCursorSchema,
  zendeskIdentitySchema,
  zendeskListEnvelopeSchema,
  zendeskUserSchema,
} from './contracts.js';
import { zendeskContactRecord } from './records.js';

const contactCursorSchema = zendeskCursorSchema
  .safeExtend({
    offset: z.int().nonnegative().default(0),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((cursor) => cursor.offset === 0 || cursor.fingerprint !== undefined);

async function identities(client: ZendeskClient, userId: number) {
  const path = `/api/v2/users/${userId}/identities.json`;
  const schema = zendeskListEnvelopeSchema.extend({
    identities: z.array(zendeskIdentitySchema).max(100),
  });
  const collected: z.infer<typeof zendeskIdentitySchema>[] = [];
  let pageNumber = 1;
  while (true) {
    const page = await client.json(path, schema, { page: String(pageNumber), per_page: '100' });
    collected.push(...page.identities);
    if (collected.length > 1000) throw new ConnectorError('invalid-response');
    const next = client.nextOffset(page.next_page, path, pageNumber);
    if (next === null) return collected;
    pageNumber = next;
  }
}

/** Each contact checkpoints separately, so a throttled hydration never repeats the whole user page. */
export async function* exportZendeskContacts(
  client: ZendeskClient,
  request: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let checkpoint = contactCursorSchema.parse(
    request ?? { startTime: since ? Math.max(0, Math.floor(since.getTime() / 1000)) : 0 },
  );
  const schema = zendeskCursorEnvelopeSchema.extend({
    users: z.array(zendeskUserSchema).max(1000),
  });
  while (true) {
    const page = await client.json(
      '/api/v2/incremental/users/cursor.json',
      schema,
      {
        per_page: '100',
        ...(checkpoint.after === undefined
          ? { start_time: String(checkpoint.startTime) }
          : { cursor: checkpoint.after }),
      },
      { slot: 'zendesk.contact-batch' },
    );
    const fingerprint = hashImportValue(page.users);
    if (
      (checkpoint.fingerprint && checkpoint.fingerprint !== fingerprint) ||
      checkpoint.offset > page.users.length
    )
      throw new ConnectorError('invalid-response');
    for (let index = checkpoint.offset; index < page.users.length; index++) {
      const user = page.users[index];
      if (!user) throw new ConnectorError('invalid-response');
      const sourceIdentities = await identities(client, user.id).catch(async (error: unknown) => {
        if (!(error instanceof ConnectorError) || error.code !== 'record-unavailable') throw error;
        await client.warnUnavailableContact(user.id);
        return [];
      });
      const record = zendeskContactRecord(user, sourceIdentities);
      const continuation = z
        .record(z.string(), z.json())
        .parse({ ...checkpoint, offset: index + 1, fingerprint });
      yield { records: [record], cursor: continuation };
    }
    const next = { after: page.after_cursor };
    if (page.end_of_stream) {
      yield { records: [], cursor: null, deltaCursor: next };
      return;
    }
    checkpoint = contactCursorSchema.parse(next);
  }
}

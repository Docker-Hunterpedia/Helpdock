import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { RUN_SNAPSHOT } from '../http.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';
import { zohoCustomValues } from './field-values.js';
import { readZohoFields } from './fields-export.js';
import {
  zohoAccountSchema,
  zohoAgentSchema,
  zohoContactSchema,
  zohoDepartmentSchema,
} from './people-contracts.js';
import { zohoNativeValues } from './profile-fields.js';

export function zohoContactRecord(contact: z.infer<typeof zohoContactSchema>): ImportRecord {
  return importRecordSchema.parse({
    entity: 'contact',
    payload: {
      externalId: contact.id,
      name:
        [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || `#${contact.id}`,
      emails: [
        ...new Set(
          [contact.email, contact.secondaryEmail].filter((value): value is string => !!value),
        ),
      ],
      phones: [
        ...new Set([contact.phone, contact.mobile].filter((value): value is string => !!value)),
      ],
      ...(contact.accountId ? { organizationExternalId: contact.accountId } : {}),
      ...(contact.language ? { locale: contact.language } : {}),
      ...(contact.description ? { description: contact.description } : {}),
      createdAt: contact.createdTime,
      updatedAt: contact.modifiedTime,
      custom: zohoNativeValues('contact', contact, contact.cf),
    },
  });
}

export function zohoAccountRecord(account: z.infer<typeof zohoAccountSchema>): ImportRecord {
  // Website is preserved as a source field. A website URL is not proof that a
  // company owns that email domain, so it cannot silently merge local accounts.
  return importRecordSchema.parse({
    entity: 'organization',
    payload: {
      externalId: account.id,
      name: account.accountName.trim() || `#${account.id}`,
      domains: [],
      ...(account.description ? { description: account.description } : {}),
      createdAt: account.createdTime,
      updatedAt: account.modifiedTime,
      custom: zohoNativeValues('organization', account, account.cf),
    },
  });
}

const cursorSchema = z.strictObject({
  from: z.int().min(0).max(2147483647),
  ids: z.array(zohoIdSchema).max(100),
  offset: z.int().min(0).max(100),
  terminal: z.boolean(),
});

/** Ordinary profile APIs do not promise modified-time deltas: rescan and use native load receipts. */
export async function* exportZohoProfiles(
  client: ZohoDeskClient,
  entity: 'contact' | 'organization',
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  const collection = entity === 'contact' ? 'contacts' : 'accounts';
  let cursor = cursorSchema.parse(raw ?? { from: 0, ids: [], offset: 0, terminal: false });
  let fields: Awaited<ReturnType<typeof readZohoFields>> | undefined;
  while (true) {
    if (cursor.offset > cursor.ids.length) throw new ConnectorError('invalid-response');
    const id = cursor.ids[cursor.offset];
    if (id !== undefined) {
      fields ??= await readZohoFields(client, entity);
      let record: ImportRecord;
      if (entity === 'contact') {
        const profile = await client.json(`/api/v1/${collection}/${id}`, zohoContactSchema);
        if (profile.id !== id) throw new ConnectorError('invalid-response');
        if (profile.isDeleted || profile.isTrashed || profile.isSpam)
          await client.warnInactiveProfile(entity, id);
        record = zohoContactRecord({ ...profile, cf: zohoCustomValues(fields, profile.cf) });
      } else {
        const profile = await client.json(`/api/v1/${collection}/${id}`, zohoAccountSchema);
        if (profile.id !== id) throw new ConnectorError('invalid-response');
        if (profile.isDeleted || profile.isTrashed) await client.warnInactiveProfile(entity, id);
        record = zohoAccountRecord({ ...profile, cf: zohoCustomValues(fields, profile.cf) });
      }
      cursor = { ...cursor, offset: cursor.offset + 1 };
      yield { records: [record], cursor };
    } else if (cursor.terminal) {
      yield { records: [], cursor: null };
      return;
    } else {
      const page = await client.list(
        `/api/v1/${collection}`,
        z.object({ data: z.array(z.object({ id: zohoIdSchema })).max(100) }),
        { from: String(cursor.from), limit: '100', sortBy: 'createdTime' },
      );
      const ids = page.data.map((row) => row.id);
      if (new Set(ids).size !== ids.length) throw new ConnectorError('invalid-response');
      cursor = cursorSchema.parse({
        from: cursor.from + ids.length,
        ids,
        offset: 0,
        terminal: ids.length < 100,
      });
      yield { records: [], cursor };
    }
  }
}

const agentsCursor = z.strictObject({
  status: z.int().min(0).max(3),
  from: z.int().min(0).max(2147483647),
});
const states = ['ACTIVE', 'DISABLED', 'DELETED', 'IMPORTED'] as const;
export async function* exportZohoAgents(
  client: ZohoDeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let cursor = agentsCursor.parse(raw ?? { status: 0, from: 0 });
  while (true) {
    const status = states[cursor.status];
    if (!status) throw new ConnectorError('invalid-response');
    const page = await client.list(
      '/api/v1/agents',
      z.object({ data: z.array(zohoAgentSchema).max(200) }),
      {
        status,
        from: String(cursor.from),
        limit: '200',
        include: 'profile,role',
        sortOrder: 'asc',
      },
    );
    if (
      page.data.some((agent) => agent.status !== status) ||
      new Set(page.data.map((agent) => agent.id)).size !== page.data.length
    )
      throw new ConnectorError('invalid-response');
    const next =
      page.data.length === 200
        ? { ...cursor, from: cursor.from + 200 }
        : cursor.status < 3
          ? { status: cursor.status + 1, from: 0 }
          : null;
    yield {
      records: page.data.map((agent) =>
        importRecordSchema.parse({
          entity: 'user',
          payload: {
            externalId: agent.id,
            kind: 'agent',
            name:
              agent.name?.trim() ||
              [agent.firstName, agent.lastName].filter(Boolean).join(' ').trim() ||
              `#${agent.id}`,
            active: agent.status === 'ACTIVE',
            role: agent.rolePermissionType,
            groups: agent.associatedDepartmentIds,
            ...(agent.emailId ? { email: agent.emailId } : {}),
            ...(agent.phone ? { phone: agent.phone } : {}),
          },
        }),
      ),
      cursor: next,
    };
    if (!next) return;
    cursor = agentsCursor.parse(next);
  }
}

export async function* exportZohoDepartments(
  client: ZohoDeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  const schema = z.strictObject({ enabled: z.boolean(), from: z.int().min(0).max(2147483647) });
  let cursor = schema.parse(raw ?? { enabled: true, from: 0 });
  while (true) {
    // The archived-ticket scan replays these pages, so it walks only the staged departments.
    const page = await client.list(
      '/api/v1/departments',
      z.object({ data: z.array(zohoDepartmentSchema).max(200) }),
      { from: String(cursor.from), limit: '200', isEnabled: String(cursor.enabled) },
      RUN_SNAPSHOT,
    );
    if (
      page.data.some((department) => department.isEnabled !== cursor.enabled) ||
      new Set(page.data.map((department) => department.id)).size !== page.data.length
    )
      throw new ConnectorError('invalid-response');
    const next =
      page.data.length === 200
        ? { ...cursor, from: cursor.from + 200 }
        : cursor.enabled
          ? { enabled: false, from: 0 }
          : null;
    yield {
      records: page.data.map((department) =>
        importRecordSchema.parse({
          entity: 'group',
          payload: { externalId: department.id, name: department.name },
        }),
      ),
      cursor: next,
    };
    if (!next) return;
    cursor = next;
  }
}

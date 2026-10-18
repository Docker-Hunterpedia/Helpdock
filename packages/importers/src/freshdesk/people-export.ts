import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { RUN_SNAPSHOT } from '../http.js';
import type { FreshdeskClient } from './client.js';
import {
  freshdeskAgentSchema,
  freshdeskCompanySchema,
  freshdeskContactSchema,
  freshdeskGroupSchema,
} from './contracts.js';
import { freshdeskProfileValues } from './profile-fields.js';

const checkpointSchema = z.strictObject({
  page: z.number().int().positive().max(1000000),
  collection: z.enum(['agents', 'contacts']).default('agents'),
});

export function freshdeskContactRecord(
  contact: z.infer<typeof freshdeskContactSchema>,
): ImportRecord {
  return importRecordSchema.parse({
    entity: 'contact',
    payload: {
      externalId: String(contact.id),
      name: contact.name.trim() ? contact.name : `#${contact.id}`,
      emails: [...new Set([...(contact.email ? [contact.email] : []), ...contact.other_emails])],
      phones: [
        ...new Set(
          [contact.phone, contact.mobile].filter((value): value is string => Boolean(value)),
        ),
      ],
      ...(contact.company_id ? { organizationExternalId: String(contact.company_id) } : {}),
      ...(contact.language ? { locale: contact.language } : {}),
      ...(contact.time_zone ? { timezone: contact.time_zone } : {}),
      ...(contact.unique_external_id ? { externalRef: contact.unique_external_id } : {}),
      ...(contact.description ? { description: contact.description } : {}),
      custom: freshdeskProfileValues('contact', contact, contact.custom_fields),
      createdAt: contact.created_at,
      updatedAt: contact.updated_at,
    },
  });
}

export async function* exportFreshdeskContacts(
  client: FreshdeskClient,
  raw: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let page = checkpointSchema.parse(raw ?? { page: 1 }).page;
  while (true) {
    const result = await client.page(
      '/api/v2/contacts',
      freshdeskContactSchema,
      {
        page: String(page),
        per_page: '100',
        ...(since ? { updated_since: since.toISOString() } : {}),
      },
      RUN_SNAPSHOT,
    );
    yield {
      records: result.rows.map(freshdeskContactRecord),
      cursor: result.nextPage ? { page: result.nextPage } : null,
    };
    if (!result.nextPage) return;
    page = result.nextPage;
  }
}

export async function* exportFreshdeskUsers(
  client: FreshdeskClient,
  raw: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let checkpoint = checkpointSchema.parse(raw ?? { page: 1, collection: 'agents' });
  while (true) {
    const query = { page: String(checkpoint.page), per_page: '100' };
    if (checkpoint.collection === 'agents') {
      const result = await client.page('/api/v2/agents', freshdeskAgentSchema, query);
      const next = result.nextPage
        ? { collection: 'agents' as const, page: result.nextPage }
        : { collection: 'contacts' as const, page: 1 };
      yield {
        records: result.rows.map((agent) =>
          importRecordSchema.parse({
            entity: 'user',
            payload: {
              externalId: String(agent.id),
              kind: 'agent',
              name: agent.contact.name || `#${agent.id}`,
              active: agent.contact.active,
              role: agent.type,
              groups: agent.group_ids.map(String),
              ...(agent.contact.email ? { email: agent.contact.email } : {}),
              ...(agent.contact.phone ? { phone: agent.contact.phone } : {}),
            },
          }),
        ),
        cursor: next,
      };
      checkpoint = next;
    } else {
      // The contact entity replays these pages, so customers and contacts stay one set.
      const result = await client.page(
        '/api/v2/contacts',
        freshdeskContactSchema,
        { ...query, ...(since ? { updated_since: since.toISOString() } : {}) },
        RUN_SNAPSHOT,
      );
      const next = result.nextPage
        ? { collection: 'contacts' as const, page: result.nextPage }
        : null;
      yield {
        records: result.rows.map((contact) =>
          importRecordSchema.parse({
            entity: 'user',
            payload: {
              externalId: String(contact.id),
              kind: 'customer',
              name: contact.name || `#${contact.id}`,
              // Freshdesk's active flag means email verification, not permission to access Helpdock.
              active: !contact.deleted && !contact.blocked,
              ...(contact.email ? { email: contact.email } : {}),
              ...(contact.phone ? { phone: contact.phone } : {}),
            },
          }),
        ),
        cursor: next,
      };
      if (!next) return;
      checkpoint = next;
    }
  }
}

export async function* exportFreshdeskOrganizations(
  client: FreshdeskClient,
  raw: ImportCursor | null,
  since?: Date,
): AsyncGenerator<ImportPage> {
  let page = checkpointSchema.parse(raw ?? { page: 1 }).page;
  while (true) {
    const result = await client.page('/api/v2/companies', freshdeskCompanySchema, {
      page: String(page),
      per_page: '100',
      ...(since ? { updated_since: since.toISOString() } : {}),
    });
    yield {
      records: result.rows.map((company) =>
        importRecordSchema.parse({
          entity: 'organization',
          payload: {
            externalId: String(company.id),
            name: company.name,
            domains: company.domains,
            ...(company.description ? { description: company.description } : {}),
            ...(company.note ? { notes: company.note } : {}),
            custom: freshdeskProfileValues('organization', company, company.custom_fields),
            createdAt: company.created_at,
            updatedAt: company.updated_at,
          },
        }),
      ),
      cursor: result.nextPage ? { page: result.nextPage } : null,
    };
    if (!result.nextPage) return;
    page = result.nextPage;
  }
}

export async function* exportFreshdeskGroups(
  client: FreshdeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let page = checkpointSchema.parse(raw ?? { page: 1 }).page;
  while (true) {
    const result = await client.page('/api/v2/groups', freshdeskGroupSchema, {
      page: String(page),
      per_page: '100',
    });
    yield {
      records: result.rows.map((group) =>
        importRecordSchema.parse({
          entity: 'group',
          payload: {
            externalId: String(group.id),
            name: group.name,
          },
        }),
      ),
      cursor: result.nextPage ? { page: result.nextPage } : null,
    };
    if (!result.nextPage) return;
    page = result.nextPage;
  }
}

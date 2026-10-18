import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import type { z } from 'zod';
import type {
  zendeskGroupSchema,
  zendeskIdentitySchema,
  zendeskOrganizationSchema,
  zendeskTicketSchema,
  zendeskUserSchema,
} from './contracts.js';

export function zendeskTicketRecord(
  ticket: z.infer<typeof zendeskTicketSchema>,
  origin: string,
): ImportRecord {
  return importRecordSchema.parse({
    entity: 'ticket',
    payload: {
      externalId: String(ticket.id),
      number: String(ticket.id),
      subject: ticket.subject,
      status: ticket.custom_status_id
        ? `${ticket.status}:${ticket.custom_status_id}`
        : ticket.status,
      ...(ticket.priority == null ? {} : { priority: ticket.priority }),
      ...(ticket.via ? { channel: ticket.via.channel } : {}),
      ...(ticket.requester_id ? { requesterExternalId: String(ticket.requester_id) } : {}),
      ...(ticket.assignee_id ? { assigneeExternalId: String(ticket.assignee_id) } : {}),
      ...(ticket.organization_id ? { organizationExternalId: String(ticket.organization_id) } : {}),
      ...(ticket.group_id ? { groupExternalId: String(ticket.group_id) } : {}),
      ccEmails: [],
      ccExternalIds: (ticket.email_cc_ids ?? ticket.collaborator_ids ?? []).map(String),
      tags: ticket.tags,
      custom: Object.fromEntries(
        (ticket.custom_fields ?? []).map((field) => [String(field.id), field.value]),
      ),
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      sourceUrl: new URL(`/agent/tickets/${ticket.id}`, origin).href,
    },
  });
}

export function zendeskUserRecord(user: z.infer<typeof zendeskUserSchema>): ImportRecord {
  return importRecordSchema.parse({
    entity: 'user',
    payload: {
      externalId: String(user.id),
      kind: user.role === 'end-user' ? 'customer' : 'agent',
      name: user.name,
      role: user.role,
      active: user.active !== false && !user.deleted && !user.suspended,
      ...(user.email == null ? {} : { email: user.email }),
      ...(user.phone == null ? {} : { phone: user.phone }),
    },
  });
}

export function zendeskOrganizationRecord(
  organization: z.infer<typeof zendeskOrganizationSchema>,
): ImportRecord {
  return importRecordSchema.parse({
    entity: 'organization',
    payload: {
      externalId: String(organization.id),
      name: organization.name,
      domains: organization.domain_names,
      ...(organization.notes == null ? {} : { notes: organization.notes }),
      ...(organization.details == null ? {} : { description: organization.details }),
      ...(organization.created_at === undefined ? {} : { createdAt: organization.created_at }),
      ...(organization.updated_at === undefined ? {} : { updatedAt: organization.updated_at }),
      custom: organization.organization_fields ?? {},
    },
  });
}

export function zendeskGroupRecord(group: z.infer<typeof zendeskGroupSchema>): ImportRecord {
  return importRecordSchema.parse({
    entity: 'group',
    payload: { externalId: String(group.id), name: group.name },
  });
}

export function zendeskContactRecord(
  user: z.infer<typeof zendeskUserSchema>,
  identities: z.infer<typeof zendeskIdentitySchema>[],
): ImportRecord {
  return importRecordSchema.parse({
    entity: 'contact',
    payload: {
      externalId: String(user.id),
      name: user.name,
      emails: [
        ...new Set([
          ...(user.email ? [user.email] : []),
          ...identities
            .filter((identity) => identity.type === 'email')
            .map((identity) => identity.value),
        ]),
      ],
      phones: [
        ...new Set([
          ...(user.phone ? [user.phone] : []),
          ...identities
            .filter((identity) => identity.type === 'phone_number')
            .map((identity) => identity.value),
        ]),
      ],
      ...(user.organization_id ? { organizationExternalId: String(user.organization_id) } : {}),
      ...(user.locale ? { locale: user.locale } : {}),
      ...(user.iana_time_zone || user.time_zone
        ? { timezone: user.iana_time_zone ?? user.time_zone }
        : {}),
      ...(user.external_id ? { externalRef: user.external_id } : {}),
      custom: user.user_fields ?? {},
      ...(user.notes == null ? {} : { notes: user.notes }),
      ...(user.details == null ? {} : { description: user.details }),
      ...(user.created_at === undefined ? {} : { createdAt: user.created_at }),
      ...(user.updated_at === undefined ? {} : { updatedAt: user.updated_at }),
      sourceIdentities: identities.map((identity) => ({
        externalId: String(identity.id),
        type: identity.type,
        value: identity.value,
        ...(identity.primary === undefined ? {} : { primary: identity.primary }),
        ...(identity.verification_method === undefined
          ? {}
          : { verificationMethod: identity.verification_method }),
      })),
    },
  });
}

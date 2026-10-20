import { describe, expect, it } from 'vitest';
import { scopesForEvents, webhookCreateRequestSchema, webhookUpdateRequestSchema } from './api.js';
import { webhookSourcePayloadSchemas } from './webhook-events.js';

const ID = '0192a000-0000-7000-8000-000000000001';
const ticket = { ticketId: ID, departmentId: ID };
const examples = {
  'ticket.assigned': { ...ticket, assigneeId: ID, assignedBy: 'person', actorId: ID },
  'ticket.status_changed': { ...ticket, previousStatusId: ID, statusId: ID },
  'ticket.merged': { ...ticket, mergedIntoId: ID, previousDepartmentId: ID },
  'message.created': { ...ticket, messageId: ID },
  'contact.updated': { contactId: ID, departmentId: null },
  'contact.merged': { contactId: ID, mergedContactId: ID, departmentId: null },
  'account.created': { accountId: ID, departmentId: null },
  'account.updated': { accountId: ID, departmentId: null },
};

describe('M14-28 webhook contracts', () => {
  it.each(Object.keys(examples) as (keyof typeof examples)[])(
    '%s requires its reference and scope',
    (event) => {
      const schema = webhookSourcePayloadSchemas[event];
      expect(schema.parse(examples[event])).toEqual(examples[event]);
      const { departmentId: _scope, ...unscoped } = examples[event];
      expect(schema.safeParse(unscoped).success).toBe(false);
      expect(
        schema.safeParse({
          ...examples[event],
          ticketId: 'invalid',
          contactId: 'invalid',
          accountId: 'invalid',
        }).success,
      ).toBe(false);
      expect(
        webhookCreateRequestSchema.safeParse({ url: 'https://example.com/hooks', events: [event] })
          .success,
      ).toBe(true);
      expect(scopesForEvents([event])).toEqual([
        event.startsWith('contact.') || event.startsWith('account.')
          ? 'contacts:read'
          : 'tickets:read',
      ]);
    },
  );

  it('allows an explicit notes-only update and refuses ambiguous opt-ins', () => {
    expect(webhookUpdateRequestSchema.parse({ includeInternalNotes: true })).toEqual({
      includeInternalNotes: true,
    });
    expect(
      webhookCreateRequestSchema.parse({
        url: 'https://example.com/hooks',
        events: ['message.created'],
      }),
    ).not.toHaveProperty('includeInternalNotes');
    expect(webhookUpdateRequestSchema.safeParse({ includeInternalNotes: 'true' }).success).toBe(
      false,
    );
  });
});

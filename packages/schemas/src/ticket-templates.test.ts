import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_PLACEHOLDERS,
  ticketTemplateCreateRequestSchema,
  ticketTemplatePreviewQuerySchema,
  ticketTemplateUpdateRequestSchema,
} from './ticket-templates.js';

const valid = { name: 'Refund request', subject: 'Refund for {{contact.name}}', bodyText: 'Hi.' };

describe('ticketTemplateCreateRequestSchema', () => {
  it('defaults the parts a template need not decide', () => {
    expect(ticketTemplateCreateRequestSchema.parse(valid)).toMatchObject({
      priority: 'medium',
      defaultTagIds: [],
      customDefaults: {},
    });
    expect(ticketTemplateCreateRequestSchema.parse(valid).departmentId).toBeUndefined();
  });

  it('refuses an empty subject or body, which would be a template of nothing', () => {
    expect(ticketTemplateCreateRequestSchema.safeParse({ ...valid, subject: ' ' }).success).toBe(
      false,
    );
    expect(ticketTemplateCreateRequestSchema.safeParse({ ...valid, bodyText: '' }).success).toBe(
      false,
    );
  });

  it('accepts a null department, which means "the person filing it chooses"', () => {
    expect(
      ticketTemplateCreateRequestSchema.parse({ ...valid, departmentId: null }).departmentId,
    ).toBeNull();
  });
});

describe('ticketTemplateUpdateRequestSchema', () => {
  it('refuses a body that changes nothing', () => {
    expect(ticketTemplateUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('lets a template be moved out of every department', () => {
    expect(ticketTemplateUpdateRequestSchema.parse({ departmentId: null }).departmentId).toBeNull();
  });
});

describe('ticketTemplatePreviewQuerySchema', () => {
  it('takes no contact, which is what an author previewing from the editor sends', () => {
    expect(ticketTemplatePreviewQuerySchema.parse({})).toEqual({});
  });
});

describe('TEMPLATE_PLACEHOLDERS', () => {
  it('is an allow-list and names nothing reachable through a prototype', () => {
    // The renderer resolves these names and nothing else, which is what stops
    // `{{constructor.constructor}}` being answered.
    expect([...TEMPLATE_PLACEHOLDERS]).toEqual([
      'contact.first_name',
      'contact.last_name',
      'contact.name',
      'contact.email',
      'ticket.number',
      'brand.name',
    ]);
  });
});

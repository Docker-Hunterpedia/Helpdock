import { describe, expect, it } from 'vitest';
import { routingTestRequestSchema } from './automation-routing.js';

const ID = '0199f4b2-0000-7000-8000-0000000000a1';

describe('routingTestRequestSchema', () => {
  it('fills in an empty sample', () => {
    expect(routingTestRequestSchema.parse({ entry: 'widget', entryId: null })).toEqual({
      entry: 'widget',
      entryId: null,
      from: '',
      fromName: '',
      subject: '',
      message: '',
      language: 'auto',
    });
  });

  it('wants an id for a mailbox, a bot or an account, and none for the others', () => {
    expect(routingTestRequestSchema.safeParse({ entry: 'mailbox', entryId: null }).success).toBe(
      false,
    );
    expect(routingTestRequestSchema.safeParse({ entry: 'telegram_bot', entryId: ID }).success).toBe(
      true,
    );
    expect(routingTestRequestSchema.safeParse({ entry: 'web_form', entryId: ID }).success).toBe(
      false,
    );
  });

  it('wants a department for an API request and for nothing else', () => {
    expect(routingTestRequestSchema.safeParse({ entry: 'api_key', entryId: null }).success).toBe(
      false,
    );
    expect(
      routingTestRequestSchema.safeParse({ entry: 'api_key', entryId: null, departmentId: ID })
        .success,
    ).toBe(true);
    expect(
      routingTestRequestSchema.safeParse({ entry: 'widget', entryId: null, departmentId: ID })
        .success,
    ).toBe(false);
  });

  it('bounds the sample', () => {
    const tooLong = 'x'.repeat(10_001);

    expect(
      routingTestRequestSchema.safeParse({ entry: 'widget', entryId: null, message: tooLong })
        .success,
    ).toBe(false);
    expect(
      routingTestRequestSchema.safeParse({ entry: 'widget', entryId: null, language: 'fr' })
        .success,
    ).toBe(false);
  });
});

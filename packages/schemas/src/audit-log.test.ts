import { describe, expect, it } from 'vitest';
import { AUDIT_PAGE_SIZE, auditActionFilterSchema, auditLogQuerySchema } from './audit-log.js';

describe('auditActionFilterSchema', () => {
  it.each(['settings.updated', 'install.scope.access', 'ticket.*', 'macro.*'])(
    'accepts %s',
    (value) => {
      expect(auditActionFilterSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['%', 'ticket.%', 'a b', '*', 'ticket.*.x'])(
    'refuses %s, which would reach a LIKE',
    (value) => {
      expect(auditActionFilterSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('auditLogQuerySchema', () => {
  it('pages by fifty unless asked otherwise', () => {
    expect(auditLogQuerySchema.parse({}).limit).toBe(AUDIT_PAGE_SIZE);
  });

  it('takes a brand id or the install', () => {
    expect(auditLogQuerySchema.safeParse({ brand: 'install' }).success).toBe(true);
    expect(auditLogQuerySchema.safeParse({ brand: 'acme' }).success).toBe(false);
  });

  it('refuses a range that ends before it starts', () => {
    expect(
      auditLogQuerySchema.safeParse({
        from: '2026-09-27T00:00:00Z',
        to: '2026-09-20T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});

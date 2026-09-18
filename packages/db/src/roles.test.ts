import { describe, expect, it } from 'vitest';
import {
  APP_ROLE_NAME,
  type RuntimeRoleFacts,
  UnsafeRuntimeRoleError,
  unsafeRuntimeRoleReasons,
} from './roles.js';

const facts = (overrides: Partial<RuntimeRoleFacts> = {}): RuntimeRoleFacts => ({
  roleName: APP_ROLE_NAME,
  superuser: false,
  bypassRls: false,
  ownedTables: 0,
  ...overrides,
});

describe('unsafeRuntimeRoleReasons', () => {
  it('accepts a role that can only read and write rows', () => {
    expect(unsafeRuntimeRoleReasons(facts())).toEqual([]);
  });

  it('rejects a superuser', () => {
    expect(unsafeRuntimeRoleReasons(facts({ superuser: true }))).toHaveLength(1);
  });

  it('rejects BYPASSRLS', () => {
    expect(unsafeRuntimeRoleReasons(facts({ bypassRls: true }))).toHaveLength(1);
  });

  it('rejects a role that owns tables, because FORCE is the only thing binding an owner', () => {
    expect(unsafeRuntimeRoleReasons(facts({ ownedTables: 3 }))[0]).toContain('3 table(s)');
  });

  it('reports every reason at once, so one restart is enough to find them all', () => {
    expect(
      unsafeRuntimeRoleReasons(facts({ superuser: true, bypassRls: true, ownedTables: 1 })),
    ).toHaveLength(3);
  });
});

describe('UnsafeRuntimeRoleError', () => {
  it('names the role and what to do about it', () => {
    const error = new UnsafeRuntimeRoleError('postgres', ['it is a superuser, or a member of one']);

    expect(error.message).toContain('postgres');
    expect(error.message).toContain(APP_ROLE_NAME);
    expect(error.reasons).toHaveLength(1);
  });
});

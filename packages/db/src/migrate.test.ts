import { describe, expect, it } from 'vitest';
import { appRolePasswordFromUrl, newlyAppliedTags } from './migrate.js';

const journal = {
  entries: [
    { when: 1_789_765_607_157, tag: '0000_core_tables' },
    { when: 1_789_765_623_084, tag: '0001_app_role_and_ticket_sequences' },
    { when: 1_789_765_623_418, tag: '0002_tenant_rls_policies' },
  ],
};

describe('newlyAppliedTags', () => {
  it('reports every migration on a fresh database', () => {
    const after = new Set(journal.entries.map((entry) => entry.when));

    expect(newlyAppliedTags(journal, new Set(), after)).toEqual([
      '0000_core_tables',
      '0001_app_role_and_ticket_sequences',
      '0002_tenant_rls_policies',
    ]);
  });

  it('reports nothing when the database was already up to date', () => {
    const applied = new Set(journal.entries.map((entry) => entry.when));

    expect(newlyAppliedTags(journal, applied, applied)).toEqual([]);
  });

  it('reports only what this run added, which is how a second replica stays quiet', () => {
    const before = new Set([1_789_765_607_157]);
    const after = new Set([1_789_765_607_157, 1_789_765_623_084]);

    expect(newlyAppliedTags(journal, before, after)).toEqual([
      '0001_app_role_and_ticket_sequences',
    ]);
  });
});

describe('appRolePasswordFromUrl', () => {
  it('reads the password of the runtime role', () => {
    expect(appRolePasswordFromUrl('postgres://helpdock_app:s3cret@db:5432/helpdock')).toBe(
      's3cret',
    );
  });

  it('decodes a password that had to be escaped in the URL', () => {
    expect(appRolePasswordFromUrl('postgres://helpdock_app:p%40ss%3Aword@db:5432/helpdock')).toBe(
      'p@ss:word',
    );
  });

  it('refuses a URL that connects as another role', () => {
    expect(() => appRolePasswordFromUrl('postgres://postgres:s3cret@db:5432/helpdock')).toThrow(
      /helpdock_app/,
    );
  });

  it('refuses a URL with no password', () => {
    expect(() => appRolePasswordFromUrl('postgres://helpdock_app@db:5432/helpdock')).toThrow(
      /password/,
    );
  });

  it('never puts the password in the error', () => {
    expect(() => appRolePasswordFromUrl('postgres://postgres:s3cret@db:5432/helpdock')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('s3cret') }),
    );
  });
});

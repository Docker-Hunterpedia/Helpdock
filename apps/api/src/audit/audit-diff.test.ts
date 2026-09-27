import { describe, expect, it } from 'vitest';
import { auditDiffOf, isSecretField } from './audit-diff.js';

describe('auditDiffOf', () => {
  it('turns a before/after pair into one row per field that moved', () => {
    expect(
      auditDiffOf({
        before: { smtp: { host: 'old', port: 587 } },
        after: { smtp: { host: 'new', port: 465 } },
      }).changes,
    ).toEqual([
      { field: 'smtp.host', before: 'old', after: 'new', secret: false },
      { field: 'smtp.port', before: '587', after: '465', secret: false },
    ]);
  });

  it('reads the from/to pair M1 wrote for a role change', () => {
    const { changes, details } = auditDiffOf({
      from: { role: 'agent' },
      to: { role: 'team_leader', departmentIds: ['a'] },
    });

    expect(changes).toEqual([
      { field: 'role', before: 'agent', after: 'team_leader', secret: false },
      { field: 'departmentIds', before: null, after: '["a"]', secret: false },
    ]);
    expect(details).toEqual([]);
  });

  it('reads a `changes` object as changes with no before', () => {
    expect(auditDiffOf({ name: 'Helpdock', changes: { timezone: 'Asia/Amman' } })).toEqual({
      changes: [{ field: 'timezone', before: null, after: 'Asia/Amman', secret: false }],
      details: [{ field: 'name', value: 'Helpdock', secret: false }],
    });
  });

  it('shows that a secret changed and nothing else', () => {
    const { changes } = auditDiffOf({
      before: { 'smtp.password': 'hunter2', apiToken: 'abc' },
      after: { 'smtp.password': 'correct horse', apiToken: 'def' },
    });

    expect(changes).toEqual([
      { field: 'smtp.password', before: '[redacted]', after: '[redacted]', secret: true },
      { field: 'apiToken', before: '[redacted]', after: '[redacted]', secret: true },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/hunter2|horse|abc|def/);
  });

  it('never splits a secret object into readable fields', () => {
    const { details } = auditDiffOf({ credentials: { user: 'mona', secret: 'x' } });

    expect(details).toEqual([{ field: 'credentials', value: '[redacted]', secret: true }]);
  });

  it('keeps a pair that is not two objects as details', () => {
    expect(auditDiffOf({ before: 'x', after: 'y' }).details).toEqual([
      { field: 'before', value: 'x', secret: false },
      { field: 'after', value: 'y', secret: false },
    ]);
  });

  it('cuts a long value, and prints nested ones past the depth as JSON', () => {
    const { details } = auditDiffOf({ note: 'x'.repeat(600), a: { b: { c: { d: 1 } } } });

    expect(details[0]?.value).toHaveLength(501);
    expect(details[1]).toEqual({ field: 'a.b.c', value: '{"d":1}', secret: false });
  });
});

describe('isSecretField', () => {
  it.each(['password', 'smtp.password', 'to.smtp.password', 'botToken', 'api_key', 'privateKey'])(
    'redacts %s',
    (field) => {
      expect(isSecretField(field)).toBe(true);
    },
  );

  it.each(['smtp.host', 'tokenHash', 'name', 'to.role'])('shows %s', (field) => {
    expect(isSecretField(field)).toBe(false);
  });
});

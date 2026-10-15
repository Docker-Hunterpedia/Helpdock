import { describe, expect, it } from 'vitest';
import { importDryRunCheckpointSchema } from '../jobs/dry-run-state.js';
import { importDryRunReportView } from './dry-run-report.js';

describe('public dry-run report', () => {
  const checkpoint = importDryRunCheckpointSchema.parse({
    version: 2,
    phase: 'media_checked',
    fingerprint: 'a'.repeat(64),
    defaultCallingCode: '',
    after: null,
    checked: 300,
    issueCount: 120,
    issues: [{ entity: 'ticket', externalId: '42', code: 'author-unmapped' }],
    planIssueCount: 2,
    planIssues: [{ area: 'field', externalId: 'age', code: 'mapping-invalid' }],
    identityIssueCount: 3,
    identityIssues: [{ entity: 'contact', externalId: 'person', code: 'identity-ambiguous' }],
    recordWarningCount: 2,
    refusedPhones: 3,
    recordWarnings: [{ entity: 'contact', externalId: 'omitted-phones', code: 'phone-refused' }],
    mediaErrors: 4,
    mediaWarnings: 5,
    mediaIssues: [
      { entity: 'attachment', externalId: 'file', code: 'media-unavailable', level: 'warning' },
    ],
    mediaAfter: '01900000-0000-7000-8000-000000000001',
  });
  it('combines all error classes without confusing capped samples with totals or exposing cursors', () => {
    const report = importDryRunReportView(checkpoint, 'awaiting_mapping');
    expect(report).toMatchObject({
      complete: true,
      errors: 129,
      warnings: 7,
      refusedPhones: 3,
      recordsChecked: 300,
    });
    expect(report.issues).toEqual([
      {
        area: 'record',
        entity: 'ticket',
        externalId: '42',
        code: 'author-unmapped',
        level: 'error',
      },
      {
        area: 'record',
        entity: 'contact',
        externalId: 'omitted-phones',
        code: 'phone-refused',
        level: 'warning',
      },
      { area: 'field', externalId: 'age', code: 'mapping-invalid', level: 'error' },
      {
        area: 'identity',
        entity: 'contact',
        externalId: 'person',
        code: 'identity-ambiguous',
        level: 'error',
      },
      {
        area: 'media',
        entity: 'attachment',
        externalId: 'file',
        code: 'media-unavailable',
        level: 'warning',
      },
    ]);
    expect(report).not.toHaveProperty('mediaAfter');
    expect(report).not.toHaveProperty('after');
  });
  it.each(['dry_run', 'paused', 'failed', 'cancelled'] as const)(
    'does not label an unfinished or terminal %s run as ready for review',
    (status) => {
      expect(importDryRunReportView(checkpoint, status).complete).toBe(false);
    },
  );
  it('does not label an invalidated report as completed', () => {
    expect(
      importDryRunReportView({ ...checkpoint, phase: 'invalidated' }, 'awaiting_mapping').complete,
    ).toBe(false);
  });
});

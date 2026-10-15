import { describe, expect, it } from 'vitest';
import { importDryRunReportView, importDryRunReviewToken } from '../preflight/dry-run-report.js';
import { reviewedImportCheckpoint } from './approval.js';
import { importDryRunCheckpointSchema } from './dry-run-state.js';

describe('import approval policy', () => {
  const checkpoint = importDryRunCheckpointSchema.parse({
    version: 2,
    phase: 'media_checked',
    fingerprint: 'a'.repeat(64),
    destinationFingerprint: 'b'.repeat(64),
    defaultCallingCode: '963',
    after: null,
    checked: 3,
    issueCount: 0,
    issues: [],
  });
  const run = (report = checkpoint) => ({
    status: 'awaiting_mapping' as const,
    credentialsEncrypted: 'synthetic',
    dryRunReport: report,
  });
  const request = (report = checkpoint) => ({
    reviewToken: importDryRunReviewToken(report),
    acknowledgeWarnings: false,
  });
  it('accepts the exact completed report and retains the reviewed phone settings', () => {
    expect(reviewedImportCheckpoint(run(), request()).defaultCallingCode).toBe('963');
  });
  it.each(['fingerprint', 'destinationFingerprint'] as const)(
    'rejects a report token from different %s inputs',
    (field) => {
      const changed = { ...checkpoint, [field]: 'c'.repeat(64) };
      expect(() => reviewedImportCheckpoint(run(changed), request())).toThrow(
        'import.dry-run-stale',
      );
      expect(importDryRunReportView(changed, 'awaiting_mapping').reviewToken).not.toBe(
        request().reviewToken,
      );
    },
  );
  it('requires explicit warning acknowledgement and still refuses blocking errors', () => {
    const warnings = { ...checkpoint, recordWarningCount: 1, refusedPhones: 2 };
    expect(() => reviewedImportCheckpoint(run(warnings), request(warnings))).toThrow(
      'import.warnings-not-acknowledged',
    );
    expect(
      reviewedImportCheckpoint(run(warnings), { ...request(warnings), acknowledgeWarnings: true })
        .refusedPhones,
    ).toBe(2);
    const errors = { ...warnings, mediaErrors: 1 };
    expect(() =>
      reviewedImportCheckpoint(run(errors), { ...request(errors), acknowledgeWarnings: true }),
    ).toThrow('import.dry-run-errors');
  });
  it('refuses legacy reports without a destination snapshot', () => {
    const legacy = { ...checkpoint, destinationFingerprint: null };
    expect(() => reviewedImportCheckpoint(run(legacy), request(legacy))).toThrow(
      'import.dry-run-stale',
    );
  });
  it('refuses in-progress, paused and terminal runs even with a previously valid report token', () => {
    for (const status of [
      'dry_run',
      'paused',
      'failed',
      'cancelled',
      'completed',
      'loading',
    ] as const)
      expect(() => reviewedImportCheckpoint({ ...run(), status }, request())).toThrow(
        'import.phase-invalid',
      );
    expect(() =>
      reviewedImportCheckpoint({ ...run(), credentialsEncrypted: null }, request()),
    ).toThrow('import.phase-invalid');
  });
});

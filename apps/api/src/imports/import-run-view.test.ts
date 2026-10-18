import type { importRuns } from '@helpdock/db';
import { expect, it } from 'vitest';
import { importRunView } from './import-run-view.js';

it('serializes progress and dates without worker ownership, retry metadata or credentials', () => {
  const date = new Date('2026-10-14T00:00:00Z');
  const run: typeof importRuns.$inferSelect = {
    id: '01900000-0000-7000-8000-000000000001',
    brandId: '01900000-0000-7000-8000-000000000002',
    source: 'zendesk',
    sourceAccountKey: 'a'.repeat(64),
    mode: 'full',
    parentRunId: null,
    status: 'extracting',
    options: { internalEndpoint: 'https://vendor.example?secret=private' },
    credentialsEncrypted: 'private-envelope',
    cursors: { secret: 'private-cursor' },
    counts: {
      extracted: { ticket: 12 },
      loaded: { ticket: 3 },
      skipped: { contact: 1 },
      retryAt: date.toISOString(),
    },
    dryRunReport: null,
    error: 'private-error',
    startedBy: '01900000-0000-7000-8000-000000000003',
    createdAt: date,
    startedAt: date,
    finishedAt: null,
    updatedAt: date,
    claimedAt: date,
    claimToken: '01900000-0000-7000-8000-000000000004',
    pausedFrom: null,
  };
  const result = importRunView(run);
  expect(result).toMatchObject({
    counts: { extracted: { ticket: 12 }, loaded: { ticket: 3 }, skipped: { contact: 1 } },
    hasCredentials: true,
    startedAt: date.toISOString(),
  });
  expect(JSON.stringify(result)).not.toContain('private');
  for (const key of [
    'credentialsEncrypted',
    'claimToken',
    'claimedAt',
    'sourceAccountKey',
    'cursors',
    'options',
    'error',
  ])
    expect(result).not.toHaveProperty(key);
});

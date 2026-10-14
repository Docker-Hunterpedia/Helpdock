import { type DbTransaction, importExternalIds, importRecords } from '@helpdock/db';
import { type ImportMapping, importMappingsSchema } from '@helpdock/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportScope, importSourceAccountKey } from '../loader/external-ids.js';
import { type InvitationPlanIssue, validateInvitationPlan } from './invitation-plan.js';
import { validatedStagedRecord } from './staged-record.js';

/** Bounded read-only gathering; no invitation tokens, memberships, email or queue work. */
export async function validateImportInvitationPlan(
  tx: DbTransaction,
  scope: ImportScope,
  raw: ImportMapping[],
) {
  const requested = importMappingsSchema
    .parse(raw)
    .filter((mapping) => mapping.kind === 'agent' && mapping.target.kind === 'invited')
    .map((mapping) => mapping.externalValue);
  const account = await importSourceAccountKey(tx, scope);
  const entries: Parameters<typeof validateInvitationPlan>[0][number][] = [];
  const issues: InvitationPlanIssue[] = [];
  for (let offset = 0; offset < requested.length; offset += 500) {
    const ids = requested.slice(offset, offset + 500);
    const rows = await tx
      .select()
      .from(importRecords)
      .where(
        and(
          eq(importRecords.brandId, scope.brandId),
          eq(importRecords.runId, scope.runId),
          eq(importRecords.entity, 'user'),
          inArray(importRecords.externalId, ids),
        ),
      );
    const known = await tx
      .select({ externalId: importExternalIds.externalId })
      .from(importExternalIds)
      .where(
        and(
          eq(importExternalIds.brandId, scope.brandId),
          eq(importExternalIds.source, scope.source),
          eq(importExternalIds.sourceAccountKey, account),
          eq(importExternalIds.entity, 'user'),
          inArray(importExternalIds.externalId, ids),
        ),
      );
    const reused = new Set(known.map((row) => row.externalId));
    const byId = new Map(rows.map((row) => [row.externalId, row]));
    for (const externalId of ids) {
      const row = byId.get(externalId);
      if (!row) {
        issues.push({ externalId, code: 'invite-source-invalid' });
        continue;
      }
      let source: ReturnType<typeof validatedStagedRecord>;
      try {
        source = validatedStagedRecord(row);
      } catch (error) {
        if (!(error instanceof ImportLoadError)) throw error;
        issues.push({ externalId, code: 'invite-source-invalid' });
        continue;
      }
      if (source.entity !== 'user') {
        issues.push({ externalId, code: 'invite-source-invalid' });
        continue;
      }
      entries.push({
        user: {
          externalId: source.payload.externalId,
          kind: source.payload.kind,
          ...(source.payload.email ? { email: source.payload.email } : {}),
        },
        reused: reused.has(externalId),
      });
    }
  }
  return [...issues, ...validateInvitationPlan(entries)];
}

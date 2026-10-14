import {
  customFieldDefs,
  type DbTransaction,
  departments,
  importRecords,
  tags,
  teams,
  ticketStatuses,
  users,
} from '@helpdock/db';
import {
  type ImportMapping,
  importMappingSchema,
  MAX_CUSTOM_FIELDS_PER_TARGET,
  normaliseEmail,
} from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { importAssigneeEligible } from '../loader/assignee-eligibility.js';
import { type ImportScope, importedIdentity } from '../loader/external-ids.js';
import { fieldLoadSchema } from '../loader/field-contracts.js';
import { importedStaffMembership } from '../loader/staff-membership.js';
import { validatedStagedRecord } from './staged-record.js';

export type MappingTargetIssue = 'target-missing' | 'target-invalid' | 'source-missing';

/** No provisioning or field creation: proposed destinations must be valid before a dry run can approve them. */
export async function validateImportMappingTarget(
  tx: DbTransaction,
  scope: ImportScope,
  raw: ImportMapping,
): Promise<MappingTargetIssue | null> {
  const mapping = importMappingSchema.parse(raw);
  switch (mapping.kind) {
    case 'priority':
    case 'channel':
      return null;
    case 'status': {
      const [row] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.brandId, scope.brandId),
            eq(ticketStatuses.id, mapping.target.statusId),
          ),
        );
      return row ? null : 'target-missing';
    }
    case 'tag': {
      if (mapping.target.tagId === null) return null;
      const [row] = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.brandId, scope.brandId), eq(tags.id, mapping.target.tagId)));
      return row ? null : 'target-missing';
    }
    case 'group': {
      const [department] = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(
          and(
            eq(departments.brandId, scope.brandId),
            eq(departments.id, mapping.target.departmentId),
          ),
        );
      if (!department) return 'target-missing';
      if (!mapping.target.teamId) return null;
      const [team] = await tx
        .select({ departmentId: teams.departmentId })
        .from(teams)
        .where(and(eq(teams.brandId, scope.brandId), eq(teams.id, mapping.target.teamId)));
      return !team
        ? 'target-missing'
        : team.departmentId !== department.id
          ? 'target-invalid'
          : null;
    }
    case 'agent':
      return validateStaffTarget(tx, scope, mapping);
    case 'field':
      return validateFieldTarget(tx, scope, mapping);
  }
}

async function validateStaffTarget(
  tx: DbTransaction,
  scope: ImportScope,
  mapping: Extract<ImportMapping, { kind: 'agent' }>,
): Promise<MappingTargetIssue | null> {
  if (mapping.target.kind === 'name') return null;
  const known = await importedIdentity(tx, scope, 'user', mapping.externalValue);
  if (mapping.target.kind === 'existing') {
    if (known && known.helpdockId !== mapping.target.userId) return 'target-invalid';
    const member = await importedStaffMembership(tx, scope.brandId, mapping.target.userId);
    return !member
      ? 'target-missing'
      : member.role === 'viewer' || member.status === 'deactivated'
        ? 'target-invalid'
        : null;
  }
  const rows = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(
      and(
        eq(departments.brandId, scope.brandId),
        inArray(departments.id, mapping.target.departmentIds),
      ),
    );
  if (rows.length !== mapping.target.departmentIds.length) return 'target-missing';
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'user'),
        eq(importRecords.externalId, mapping.externalValue),
      ),
    );
  if (!row) return 'source-missing';
  const source = validatedStagedRecord(row);
  if (source.entity !== 'user' || source.payload.kind !== 'agent' || !source.payload.email)
    return 'target-invalid';
  if (known) {
    const member = await importedStaffMembership(tx, scope.brandId, known.helpdockId);
    return mapping.target.departmentIds.every((id) => importAssigneeEligible(member, id))
      ? null
      : 'target-invalid';
  }
  const email = normaliseEmail(source.payload.email);
  if (!email.ok) return 'target-invalid';
  // Install-wide uniqueness only: like invited staff insertion, disclose no matching user or brand.
  const [collision] = await tx
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.value}`)
    .limit(1);
  return collision ? 'target-invalid' : null;
}

async function validateFieldTarget(
  tx: DbTransaction,
  scope: ImportScope,
  mapping: Extract<ImportMapping, { kind: 'field' }>,
): Promise<MappingTargetIssue | null> {
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, 'field'),
        eq(importRecords.externalId, mapping.externalValue),
      ),
    );
  if (!row) return 'source-missing';
  const source = validatedStagedRecord(row);
  if (
    source.entity !== 'field' ||
    !fieldLoadSchema.safeParse({ ...scope, record: source.payload, mapping: mapping.target })
      .success
  )
    return 'target-invalid';
  if (mapping.target.kind === 'skip') return null;
  const target = source.payload.target === 'organization' ? 'account' : source.payload.target;
  const known = await importedIdentity(tx, scope, 'field', mapping.externalValue);
  const explicit = mapping.target.kind === 'existing' ? mapping.target.fieldId : undefined;
  if (known && explicit && known.helpdockId !== explicit) return 'target-invalid';
  const id = known?.helpdockId ?? explicit;
  if (id) {
    const [field] = await tx
      .select({ id: customFieldDefs.id })
      .from(customFieldDefs)
      .where(
        and(
          eq(customFieldDefs.brandId, scope.brandId),
          eq(customFieldDefs.id, id),
          eq(customFieldDefs.target, target),
        ),
      );
    return field ? null : 'target-missing';
  }
  if (mapping.target.kind !== 'create') return 'target-missing';
  const definitionKey = mapping.target.definition.key;
  const existing = await tx
    .select({ key: customFieldDefs.key })
    .from(customFieldDefs)
    .where(and(eq(customFieldDefs.brandId, scope.brandId), eq(customFieldDefs.target, target)));
  return existing.length >= MAX_CUSTOM_FIELDS_PER_TARGET ||
    existing.some((field) => field.key === definitionKey)
    ? 'target-invalid'
    : null;
}

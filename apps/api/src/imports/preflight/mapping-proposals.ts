import {
  customFieldDefs,
  type DbTransaction,
  importExternalIds,
  importRecords,
  tags,
  ticketStatuses,
  userBrandRoles,
  users,
} from '@helpdock/db';
import { freshdeskValueMapping, zendeskValueMapping, zohoValueMapping } from '@helpdock/importers';
import {
  type CustomFieldType,
  type ImportMapping,
  type ImportMappingValue,
  type ImportSource,
  importMappingSchema,
  normaliseEmail,
  ticketChannelSchema,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ImportRunRef } from '../jobs/claims.js';

type Scope = ImportRunRef & { source: ImportSource; sourceAccountKey: string };

async function nativeTarget(
  tx: DbTransaction,
  scope: Scope,
  kind: ImportMapping['kind'],
  externalId: string,
) {
  const entity = kind === 'agent' ? 'user' : kind;
  if (entity !== 'user' && entity !== 'group' && entity !== 'field' && entity !== 'tag')
    return null;
  const [row] = await tx
    .select({ id: importExternalIds.helpdockId })
    .from(importExternalIds)
    .where(
      and(
        eq(importExternalIds.brandId, scope.brandId),
        eq(importExternalIds.source, scope.source),
        eq(importExternalIds.sourceAccountKey, scope.sourceAccountKey),
        eq(importExternalIds.entity, entity),
        eq(importExternalIds.externalId, externalId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function statusProposal(tx: DbTransaction, scope: Scope, row: ImportMappingValue) {
  const builtins = new Map<string, typeof ticketStatuses.$inferSelect.systemKey>([
    ['new', 'open'],
    ['open', 'open'],
    ['pending', 'awaiting_customer'],
    ['hold', 'open'],
    ['solved', 'closed'],
    ['closed', 'closed'],
  ]);
  const freshdesk = new Map<string, typeof ticketStatuses.$inferSelect.systemKey>([
    ['2', 'open'],
    ['3', 'awaiting_customer'],
    ['4', 'closed'],
    ['5', 'closed'],
  ]);
  const zoho = new Map<string, typeof ticketStatuses.$inferSelect.systemKey>([
    ['open', 'open'],
    ['on hold', 'open'],
    ['onhold', 'open'],
    ['closed', 'closed'],
  ]);
  const key =
    scope.source === 'zendesk'
      ? builtins.get(row.externalValue)
      : scope.source === 'freshdesk'
        ? freshdesk.get(row.externalValue)
        : scope.source === 'zohodesk'
          ? zoho.get(row.externalValue.toLowerCase())
          : undefined;
  const matches = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(
      and(
        eq(ticketStatuses.brandId, scope.brandId),
        eq(ticketStatuses.excludedFromReports, false),
        // Snoozed needs a wake time an imported ticket does not have (M14-02).
        sql`${ticketStatuses.systemKey} IS DISTINCT FROM 'snoozed'`,
        key
          ? eq(ticketStatuses.systemKey, key)
          : sql`(lower(${ticketStatuses.name}) = lower(${row.label}) OR lower(${ticketStatuses.nameAr}) = lower(${row.label}))`,
      ),
    )
    .limit(2);
  return matches.length === 1 ? { statusId: matches[0]?.id } : null;
}

async function groupProposal(tx: DbTransaction, scope: Scope, row: ImportMappingValue) {
  const known = await nativeTarget(tx, scope, 'group', row.externalValue);
  const choices = z
    .array(z.object({ department_id: z.uuid(), team_id: z.uuid().nullable() }))
    .parse(
      await tx.execute(sql`
    SELECT d.id AS department_id, NULL::uuid AS team_id FROM departments d WHERE d.brand_id = ${scope.brandId}::uuid
      AND ${known ? sql`d.id = ${known}::uuid` : sql`lower(d.name) = lower(${row.label})`}
    UNION ALL SELECT t.department_id, t.id AS team_id FROM teams t WHERE t.brand_id = ${scope.brandId}::uuid
      AND ${known ? sql`t.id = ${known}::uuid` : sql`lower(t.name) = lower(${row.label})`} LIMIT 2
  `),
    );
  const match = choices.length === 1 ? choices[0] : undefined;
  return match ? { departmentId: match.department_id, teamId: match.team_id } : null;
}

async function staffProposal(tx: DbTransaction, scope: Scope, row: ImportMappingValue) {
  const known = await nativeTarget(tx, scope, 'agent', row.externalValue);
  const email = row.person?.email ? normaliseEmail(row.person.email) : null;
  if (!known && !email?.ok) return { kind: 'name' };
  const matches = await tx
    .select({ id: users.id })
    .from(userBrandRoles)
    .innerJoin(users, eq(users.id, userBrandRoles.userId))
    .where(
      and(
        eq(userBrandRoles.brandId, scope.brandId),
        inArray(userBrandRoles.role, ['admin', 'team_leader', 'agent']),
        inArray(users.status, ['active', 'invited']),
        known ? eq(users.id, known) : sql`lower(${users.email}) = ${email?.ok ? email.value : ''}`,
      ),
    )
    .limit(2);
  return matches.length === 1 ? { kind: 'existing', userId: matches[0]?.id } : { kind: 'name' };
}

async function fieldProposal(tx: DbTransaction, scope: Scope, row: ImportMappingValue) {
  if (!row.field) return null;
  const field = row.field;
  const target = field.target === 'organization' ? 'account' : field.target;
  // A multi-line source field fits a text field or a long text one (M14-27).
  const types: CustomFieldType[] =
    field.type === 'textarea'
      ? ['text', 'long_text']
      : field.type === 'multiselect'
        ? ['multi_select']
        : [field.type];
  const known = await nativeTarget(tx, scope, 'field', row.externalValue);
  const choices = await tx
    .select({ id: customFieldDefs.id, options: customFieldDefs.options })
    .from(customFieldDefs)
    .where(
      and(
        eq(customFieldDefs.brandId, scope.brandId),
        eq(customFieldDefs.target, target),
        inArray(customFieldDefs.type, types),
        known ? eq(customFieldDefs.id, known) : eq(customFieldDefs.key, field.key),
      ),
    )
    .limit(2);
  const match = choices.length === 1 ? choices[0] : undefined;
  if (!match) return null;
  if (field.type === 'select' || field.type === 'multiselect') {
    if (field.optionsCount > match.options.length) return null;
    const [source] = await tx
      .select({ options: sql<unknown>`${importRecords.payload}->'options'` })
      .from(importRecords)
      .where(
        and(
          eq(importRecords.brandId, scope.brandId),
          eq(importRecords.runId, scope.runId),
          eq(importRecords.entity, 'field'),
          eq(importRecords.externalId, row.externalValue),
        ),
      )
      .limit(1);
    const options = z
      .array(z.object({ value: z.string() }))
      .max(50)
      .safeParse(source?.options);
    if (!options.success || options.data.some((option) => !match.options.includes(option.value)))
      return null;
  }
  return { kind: 'existing', fieldId: match.id };
}

/** Suggestions never create staff/fields, grant roles, or silently discard an unmatched value. */
export async function proposeImportMapping(
  tx: DbTransaction,
  scope: Scope,
  kind: ImportMapping['kind'],
  row: ImportMappingValue,
): Promise<ImportMapping | null> {
  let target: unknown = null;
  switch (kind) {
    case 'priority':
    case 'channel': {
      const schema = kind === 'priority' ? ticketPrioritySchema : ticketChannelSchema;
      const direct = schema.safeParse(row.externalValue);
      target = direct.success
        ? { [kind]: direct.data }
        : row.externalValue === ''
          ? { [kind]: kind === 'priority' ? 'medium' : 'manual' }
          : scope.source === 'zendesk'
            ? zendeskValueMapping(kind, row.externalValue)?.target
            : scope.source === 'freshdesk'
              ? freshdeskValueMapping(kind, row.externalValue)?.target
              : scope.source === 'zohodesk'
                ? zohoValueMapping(kind, row.externalValue)?.target
                : null;
      break;
    }
    case 'status':
      target = await statusProposal(tx, scope, row);
      break;
    case 'group':
      target = await groupProposal(tx, scope, row);
      break;
    case 'agent':
      target = await staffProposal(tx, scope, row);
      break;
    case 'field':
      target = await fieldProposal(tx, scope, row);
      break;
    case 'tag': {
      const known = await nativeTarget(tx, scope, 'tag', row.externalValue);
      const matches = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(
          and(
            eq(tags.brandId, scope.brandId),
            known ? eq(tags.id, known) : sql`lower(${tags.name}) = lower(${row.externalValue})`,
          ),
        )
        .limit(2);
      if (matches.length === 1) target = { tagId: matches[0]?.id };
    }
  }
  return target
    ? importMappingSchema.parse({ kind, externalValue: row.externalValue, target })
    : null;
}

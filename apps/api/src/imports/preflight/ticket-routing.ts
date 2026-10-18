import type { DbTransaction } from '@helpdock/db';
import type { ImportMapping, ImportTicket } from '@helpdock/schemas';
import { importAssigneeEligible } from '../loader/assignee-eligibility.js';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportScope, importedIdentity } from '../loader/external-ids.js';
import { importedStaffMembership } from '../loader/staff-membership.js';
import { selectTicketMappings } from '../loader/ticket-mapping-selection.js';
import { validateImportMappingTarget } from './mapping-targets.js';

export async function validateImportTicketRouting(
  tx: DbTransaction,
  scope: ImportScope,
  record: ImportTicket,
  mappings: ImportMapping[],
): Promise<'mapping-invalid' | 'assignee-department' | null> {
  let selected: ReturnType<typeof selectTicketMappings>;
  try {
    selected = selectTicketMappings(record, mappings);
  } catch (error) {
    if (!(error instanceof ImportLoadError)) throw error;
    return 'mapping-invalid';
  }
  const required: ImportMapping[] = [
    { kind: 'status', externalValue: record.status, target: { statusId: selected.statusId } },
    {
      kind: 'group',
      externalValue: record.groupExternalId ?? '',
      target: { departmentId: selected.departmentId, teamId: selected.teamId },
    },
    ...selected.tags.map(({ externalValue, tagId }) => ({
      kind: 'tag' as const,
      externalValue,
      target: { tagId },
    })),
  ];
  if (selected.assignee && record.assigneeExternalId)
    required.push({
      kind: 'agent',
      externalValue: record.assigneeExternalId,
      target: selected.assignee,
    });
  for (const mapping of required)
    if (await validateImportMappingTarget(tx, scope, mapping)) return 'mapping-invalid';
  if (!selected.assignee || selected.assignee.kind === 'name') return null;
  const known = record.assigneeExternalId
    ? await importedIdentity(tx, scope, 'user', record.assigneeExternalId)
    : undefined;
  if (selected.assignee.kind === 'invited' && !known)
    return selected.assignee.departmentIds.includes(selected.departmentId)
      ? null
      : 'assignee-department';
  const userId =
    selected.assignee.kind === 'existing' ? selected.assignee.userId : known?.helpdockId;
  if (!userId) return 'mapping-invalid';
  const member = await importedStaffMembership(tx, scope.brandId, userId);
  return importAssigneeEligible(member, selected.departmentId) ? null : 'assignee-department';
}

import {
  auditLog,
  type DbTransaction,
  departments,
  userBrandRoles,
  users,
  uuidv7,
} from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { normaliseEmail } from '@helpdock/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { requireLoadingRun } from './run-scope.js';
import { type StaffLoad, staffLoadSchema } from './staff-contracts.js';

type StaffOutcome = {
  author: TicketLoad['authors'][string];
  outcome: 'created' | 'linked' | 'unchanged' | 'name';
};

export async function requireImportedStaffTarget(
  tx: DbTransaction,
  input: StaffLoad,
  userId: string,
): Promise<void> {
  const [member] = await tx
    .select({
      role: userBrandRoles.role,
      status: users.status,
      departmentIds: userBrandRoles.departmentIds,
    })
    .from(userBrandRoles)
    .innerJoin(users, eq(users.id, userBrandRoles.userId))
    .where(and(eq(userBrandRoles.brandId, input.brandId), eq(userBrandRoles.userId, userId)));
  if (!member || member.status === 'deactivated' || member.role === 'viewer')
    throw new ImportLoadError('mapping-invalid');
  const allowedDepartments = member.departmentIds;
  if (
    input.mapping.kind === 'invited' &&
    allowedDepartments !== null &&
    input.mapping.departmentIds.some((id) => !allowedDepartments.includes(id))
  )
    throw new ImportLoadError('mapping-invalid');
}

async function staffInvitation(tx: DbTransaction, input: StaffLoad) {
  if (input.mapping.kind !== 'invited' || !input.record.email)
    throw new ImportLoadError('mapping-invalid');
  const normalized = normaliseEmail(input.record.email);
  if (!normalized.ok) throw new ImportLoadError('mapping-invalid');
  const visible = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(
      and(
        eq(departments.brandId, input.brandId),
        inArray(departments.id, input.mapping.departmentIds),
      ),
    );
  if (visible.length !== input.mapping.departmentIds.length)
    throw new ImportLoadError('mapping-invalid');
  return {
    brandId: input.brandId,
    email: normalized.value,
    name: input.record.name,
    departmentIds: input.mapping.departmentIds,
  };
}

/** A new UUID has no existing sessions; a colliding email must be mapped explicitly. */
async function insertInvitedStaff(
  tx: DbTransaction,
  invitation: Awaited<ReturnType<typeof staffInvitation>>,
): Promise<string> {
  const id = uuidv7();
  const created = await tx
    .insert(users)
    .values({ id, email: invitation.email, name: invitation.name, status: 'invited' })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (!created.length) throw new ImportLoadError('identity-ambiguous');
  await tx.insert(userBrandRoles).values({
    userId: id,
    brandId: invitation.brandId,
    role: 'agent',
    departmentIds: invitation.departmentIds,
    source: 'manual',
  });
  return id;
}

async function createImportedStaff(tx: DbTransaction, input: StaffLoad): Promise<string> {
  const id = await insertInvitedStaff(tx, await staffInvitation(tx, input));
  await tx.insert(auditLog).values({
    brandId: input.brandId,
    actorType: 'system',
    actorId: `import:${input.runId}`,
    action: 'import.staff.created',
    targetType: 'user',
    targetId: id,
    meta: { source: input.source, externalId: input.record.externalId },
  });
  return id;
}

/** A named historical author is not an account; invited accounts have no token or mail side effect. */
export async function loadImportedStaff(
  tx: DbTransaction,
  request: StaffLoad,
): Promise<StaffOutcome> {
  const input = staffLoadSchema.parse(request);
  await requireLoadingRun(tx, input);
  if (input.mapping.kind === 'name')
    return { author: { kind: 'name', name: input.record.name }, outcome: 'name' };
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:${input.source}:user:${input.record.externalId}`}, 21))`,
  );
  const known = await importedIdentity(tx, input, 'user', input.record.externalId);
  const payloadHash = hashImportValue({ record: input.record, mapping: input.mapping });
  const explicitId = input.mapping.kind === 'existing' ? input.mapping.userId : undefined;
  if (known && explicitId && known.helpdockId !== explicitId)
    throw new ImportLoadError('mapping-invalid');
  const targetId = known?.helpdockId ?? explicitId;
  if (targetId) await requireImportedStaffTarget(tx, input, targetId);
  if (known?.payloadHash === payloadHash)
    return { author: { kind: 'staff', id: known.helpdockId }, outcome: 'unchanged' };
  const id = targetId ?? (await createImportedStaff(tx, input));
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    entity: 'user',
    externalId: input.record.externalId,
    helpdockId: id,
    payloadHash,
  });
  return { author: { kind: 'staff', id }, outcome: targetId ? 'linked' : 'created' };
}

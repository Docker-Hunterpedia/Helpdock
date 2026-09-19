import { auditLog, type UserBrandRole, userBrandRoles } from '@helpdock/db';
import { Controller, Get } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Requires } from '../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../context/request-context.js';

/**
 * Test scaffolding, not shipped: `tsconfig.json` keeps `src/testing` out of the
 * build, and the app mounts it only when a test passes it as an extra
 * controller.
 *
 * Three things can only be observed from inside a handler: what the `app.*`
 * session settings actually say once the transaction is open, what a tenant
 * table hands back through the policies, and whether a write survives the
 * handler throwing. All three are what DOMAIN-RULES §1.3 promises, so all three
 * are asserted through a real route rather than around one.
 */

export interface SessionSettings {
  readonly brandIds: string | null;
  readonly departmentIds: string | null;
  readonly allDepartments: string | null;
  readonly principalType: string | null;
  readonly principalId: string | null;
}

@Controller('probe')
export class ProbeController {
  /** What row-level security sees, read back from inside the request's transaction. */
  @Get('session')
  @Requires('ticket:read')
  async session(): Promise<SessionSettings> {
    const rows = await getTx().execute(sql`
      SELECT
        nullif(current_setting('app.brand_ids', true), '') AS brand_ids,
        nullif(current_setting('app.department_ids', true), '') AS department_ids,
        nullif(current_setting('app.all_departments', true), '') AS all_departments,
        nullif(current_setting('app.principal_type', true), '') AS principal_type,
        nullif(current_setting('app.principal_id', true), '') AS principal_id
    `);

    const row = rows[0] as Record<string, string | null> | undefined;
    return {
      brandIds: row?.brand_ids ?? null,
      departmentIds: row?.department_ids ?? null,
      allDepartments: row?.all_departments ?? null,
      principalType: row?.principal_type ?? null,
      principalId: row?.principal_id ?? null,
    };
  }

  /** Every row of a tenant table the transaction can reach, unfiltered by the query. */
  @Get('roles')
  @Requires('staff:manage')
  async roles(): Promise<{ brandIds: string[] }> {
    const rows: UserBrandRole[] = await getTx().select().from(userBrandRoles);
    return { brandIds: rows.map((row) => row.brandId) };
  }

  /** Writes an audit row and then fails, so a test can prove the rollback. */
  @Get('rollback')
  @Requires('settings:write')
  async rollback(): Promise<never> {
    const { targetBrandId, requestId } = requireRequestContext();
    if (targetBrandId === null) {
      throw new Error('the probe expects a brand-scoped route');
    }

    await getTx().insert(auditLog).values({
      brandId: targetBrandId,
      actorType: 'staff',
      actorId: requestId,
      action: 'probe.rollback',
      targetType: 'probe',
    });

    throw new Error('the handler failed after writing');
  }
}

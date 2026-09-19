import { type Db, departments, tickets, withTenant } from '@helpdock/db';
import type { DepartmentScope } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';

/**
 * The database half of a room join.
 *
 * "Joining a room (`ticket:<id>`, `conversation:<id>`, `department:<id>`) runs
 * the same permission check as the corresponding REST read" (DOMAIN-RULES
 * §1.4). For HTTP that check *is* row-level security, so this asks the same
 * question the same way: open a transaction with the principal's own scope and
 * see whether the row is there. The answer to "may this socket join
 * `ticket:X`" is therefore literally "would a `GET` of ticket X have found
 * one", and there is no second rule to keep in step.
 *
 * A socket is not a request, so there is no `TenantInterceptor` and no
 * `getTx()`. This is the only place in the app that opens a tenant transaction
 * outside the request lifecycle for a staff principal, which is why it is one
 * file with two reads in it.
 */
export interface RoomScopeReader {
  /** Whether the principal's scope in `brandId` reaches that ticket. */
  ticketInScope(input: RoomScopeQuery & { readonly ticketId: string }): Promise<boolean>;
  /** Whether that department belongs to `brandId` and the principal may reach it. */
  departmentInScope(input: RoomScopeQuery & { readonly departmentId: string }): Promise<boolean>;
}

export interface RoomScopeQuery {
  readonly brandId: string;
  readonly departmentIds: DepartmentScope;
  /** Recorded in `app.principal_id`, so a slow query names who asked. */
  readonly principalId: string;
}

export class DbRoomScopeReader implements RoomScopeReader {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * `tickets` is department-scoped, so the policy answers both halves at once:
   * a ticket of another brand is invisible, and so is one in a department this
   * principal does not hold.
   */
  async ticketInScope({ ticketId, ...scope }: RoomScopeQuery & { ticketId: string }) {
    return this.#exists(scope, (tx) =>
      tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId)).limit(1),
    );
  }

  /**
   * `departments` is brand-scoped only, which is exactly what an unrestricted
   * principal needs: `'all'` means "every department *of that brand*"
   * (DOMAIN-RULES §1.1), and a room name carries no brand, so the only way to
   * prove the department belongs to the brand the join named is to look. A
   * principal with an explicit list never reaches here — the list itself is
   * per-brand, so membership proves both.
   */
  async departmentInScope({ departmentId, ...scope }: RoomScopeQuery & { departmentId: string }) {
    return this.#exists(scope, (tx) =>
      tx
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, departmentId))
        .limit(1),
    );
  }

  async #exists(
    { brandId, departmentIds, principalId }: RoomScopeQuery,
    read: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<readonly unknown[]>,
  ): Promise<boolean> {
    const rows = await withTenant(
      this.#db,
      { brandIds: [brandId], departmentIds, principalType: 'staff', principalId },
      (tx) => read(tx),
    );

    return rows.length > 0;
  }
}

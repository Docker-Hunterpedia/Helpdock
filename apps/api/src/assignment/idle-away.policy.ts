import { type Db, withSystem } from '@helpdock/db';
import type { IdleAwayPolicy } from '../realtime/idle-away.policy.js';
import { AssignmentRepository } from './assignment.repository.js';
import { canWorkDepartment, isInRotation } from './rotation.js';

/**
 * M14-18's reading of "Mark idle agents away after", per person.
 *
 * A department's setting reaches the people its rotation would pick from: they
 * can work it and are in its rotation. Somebody who works several departments
 * with different limits takes the shortest, because the person asking for the
 * tightest rota is the one who needs idle agents out of it. Presence is per
 * brand, not per department, so there is no way to be away in one and not the
 * other.
 *
 * The brand's system transaction is the audited path for a read with no
 * request behind it (DOMAIN-RULES §1.4), as `OutboxStaffOfflineHook` uses. A
 * brand in which no department sets a limit stops after one small read.
 */
export class DepartmentIdleAwayPolicy implements IdleAwayPolicy {
  readonly #db: Db;
  readonly #repository = new AssignmentRepository();

  constructor(db: Db) {
    this.#db = db;
  }

  async limitsFor(brandId: string): Promise<ReadonlyMap<string, number>> {
    return withSystem(this.#db, brandId, async (tx) => {
      const limits = new Map<string, number>();
      const departments = (await this.#repository.departments(tx, brandId)).filter(
        (department) => department.idleAwayMinutes !== null,
      );
      if (departments.length === 0) {
        return limits;
      }

      const [members, rows] = await Promise.all([
        this.#repository.members(tx, brandId),
        this.#repository.rotationRows(tx, brandId),
      ]);
      const stored = new Map(
        rows.map((row) => [`${row.departmentId}:${row.userId}`, row.inRotation]),
      );

      for (const department of departments) {
        const minutes = department.idleAwayMinutes;
        if (minutes === null) {
          continue;
        }
        for (const member of members) {
          const inRotation = isInRotation({
            role: member.role,
            inRotation: stored.get(`${department.id}:${member.userId}`) ?? null,
          });
          if (canWorkDepartment(member, department.id) && inRotation) {
            limits.set(member.userId, Math.min(limits.get(member.userId) ?? minutes, minutes));
          }
        }
      }

      return limits;
    });
  }
}

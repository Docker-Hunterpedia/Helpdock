import {
  type DbTransaction,
  departments,
  teams,
  ticketActivity,
  userBrandRoles,
  users,
  workflowRules,
} from '@helpdock/db';
import type { TicketArrival } from '@helpdock/schemas';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { recordedArrival } from './arrival.js';
import { isOrigin, type TrailIds, type TrailNames, type TrailRow } from './routing-trail.js';

/**
 * The reads behind M14-08, all through the caller's transaction, so an Agent's
 * read of a ticket in another department finds no rows (DOMAIN-RULES §1.3)
 * and a name is read only where the reader's brand policy lets it be.
 */

/**
 * How far into a ticket's activity the trail looks. Rules and the rotation act
 * within moments of the arrival, and the trail stops at a person's first
 * change, so a long-lived ticket's later history is never needed.
 */
export const TRAIL_ROWS_READ = 200;

const trailColumns = {
  actorType: ticketActivity.actorType,
  actorId: ticketActivity.actorId,
  action: ticketActivity.action,
  from: ticketActivity.from,
  to: ticketActivity.to,
  via: ticketActivity.via,
  createdAt: ticketActivity.createdAt,
};

export const readTrailRows = (tx: DbTransaction, ticketId: string): Promise<TrailRow[]> =>
  tx
    .select(trailColumns)
    .from(ticketActivity)
    .where(eq(ticketActivity.ticketId, ticketId))
    .orderBy(asc(ticketActivity.createdAt), asc(ticketActivity.id))
    .limit(TRAIL_ROWS_READ);

/** The arrival a ticket recorded, for a continuation to carry on (§2.3). */
export const readArrival = async (
  tx: DbTransaction,
  ticketId: string,
): Promise<TicketArrival | undefined> => {
  const rows = await tx
    .select(trailColumns)
    .from(ticketActivity)
    .where(
      and(
        eq(ticketActivity.ticketId, ticketId),
        inArray(ticketActivity.action, ['ticket.created', 'ticket.continued']),
      ),
    )
    .orderBy(asc(ticketActivity.createdAt), asc(ticketActivity.id))
    .limit(TRAIL_ROWS_READ);
  const origin = rows.find((row) => isOrigin(ticketId, row));
  return origin === undefined ? undefined : recordedArrival(origin.to);
};

export const readTrailNames = async (
  tx: DbTransaction,
  brandId: string,
  ids: TrailIds,
): Promise<TrailNames> => {
  const departmentRows =
    ids.departmentIds.size === 0
      ? []
      : await tx
          .select({ id: departments.id, name: departments.name, nameAr: departments.nameAr })
          .from(departments)
          .where(inArray(departments.id, [...ids.departmentIds]));
  const teamRows =
    ids.teamIds.size === 0
      ? []
      : await tx
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inArray(teams.id, [...ids.teamIds]));
  // Only people who still hold a role in the brand: a name is not read across brands.
  const staffRows =
    ids.userIds.size === 0
      ? []
      : await tx
          .select({ id: users.id, name: users.name })
          .from(userBrandRoles)
          .innerJoin(users, eq(users.id, userBrandRoles.userId))
          .where(and(eq(userBrandRoles.brandId, brandId), inArray(users.id, [...ids.userIds])));
  const ruleRows =
    ids.ruleIds.size === 0
      ? []
      : await tx
          .select({ id: workflowRules.id, name: workflowRules.name })
          .from(workflowRules)
          .where(inArray(workflowRules.id, [...ids.ruleIds]));

  return {
    departments: new Map(
      departmentRows.map((row) => [row.id, { name: row.name, nameAr: row.nameAr }]),
    ),
    teams: new Map(teamRows.map((row) => [row.id, row.name])),
    staff: new Map(staffRows.map((row) => [row.id, row.name])),
    rules: new Map(ruleRows.map((row) => [row.id, row.name])),
  };
};

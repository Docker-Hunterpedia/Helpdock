import type { AssignmentMode, BrandRole } from '@helpdock/schemas';
import { reachesDepartment } from '../brands/department-scope.js';

/**
 * Who gets the next ticket (M1-07, REQUIREMENTS §4.1), as pure functions of
 * rows the caller has already read, so the rule is decided in one place and
 * proved without a database.
 *
 * ```
 * everyone in the brand
 *   → may work this department   (role reaches it, not a Viewer, not deactivated)
 *   → in rotation                (their row says so, or they are an Agent with no row)
 *   → online                     (presence, DOMAIN-RULES §12 — `away` is not)
 *   → under the department's cap (their open + escalated tickets in it)
 *   → skill_based only: whose skills match a ticket tag, or all of the above if none do
 *   → longest waiting            (oldest `last_assigned_at`, never-picked first)
 * ```
 *
 * An agent at their cap is skipped, never queued: the ticket goes to the next
 * eligible person or stays unassigned.
 */

export interface RotationMember {
  readonly userId: string;
  readonly role: BrandRole;
  /** `'all'` for an Admin, and for an unrestricted Team Leader or Viewer. */
  readonly departmentIds: readonly string[] | 'all';
  readonly deactivated: boolean;
}

export interface RotationCandidate extends RotationMember {
  /** The stored choice, or null when nobody has made one for this department. */
  readonly inRotation: boolean | null;
  readonly lastAssignedAt: Date | null;
  readonly skillTagIds: readonly string[];
}

/**
 * Whether this person may hold a ticket in this department at all. The same
 * test the picker, the manual assignment and the rotation share, so none of the
 * three can offer somebody the others refuse.
 */
export const canWorkDepartment = (member: RotationMember, departmentId: string): boolean =>
  !member.deactivated && member.role !== 'viewer' && reachesDepartment(member, departmentId);

/**
 * With no stored choice, Agents are in rotation and everyone above them is not:
 * an Admin reaches every department, and a brand that switched on round-robin
 * should not find its Admins holding tickets they never asked for.
 */
export const isInRotation = (candidate: Pick<RotationCandidate, 'role' | 'inRotation'>): boolean =>
  candidate.inRotation ?? candidate.role === 'agent';

/**
 * DOMAIN-RULES §1.2's ceiling: only an Admin routes work to an Admin. Anyone
 * else — a Team Leader, an Agent — may hand a ticket to anybody below that line
 * who can work its department.
 */
export const mayAssignTo = (actorRole: BrandRole, assigneeRole: BrandRole): boolean =>
  actorRole === 'admin' || assigneeRole !== 'admin';

/** Under the cap, or no cap. A manual assignment may exceed it; the rotation never does. */
export const underCap = (openCount: number, loadCap: number | null): boolean =>
  loadCap === null || openCount < loadCap;

export interface PickInput {
  readonly departmentId: string;
  /** `manual` is never passed: a manual department hands nothing out. */
  readonly mode: Exclude<AssignmentMode, 'manual'>;
  readonly loadCap: number | null;
  readonly candidates: readonly RotationCandidate[];
  /** Whoever is `online` in the brand right now. */
  readonly online: ReadonlySet<string>;
  readonly openCounts: ReadonlyMap<string, number>;
  readonly ticketTagIds: readonly string[];
}

const longestWaitingFirst = (left: RotationCandidate, right: RotationCandidate): number => {
  const leftAt = left.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightAt = right.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? -1 : 1;
  }

  // A stable tie-break, so two agents who have never been picked are taken in
  // the same order on every replica rather than in whatever order a read
  // happened to return them.
  return left.userId.localeCompare(right.userId);
};

/** Everyone the rotation may pick from, before skills narrow it. */
export const eligibleCandidates = (input: PickInput): readonly RotationCandidate[] =>
  input.candidates.filter(
    (candidate) =>
      canWorkDepartment(candidate, input.departmentId) &&
      isInRotation(candidate) &&
      input.online.has(candidate.userId) &&
      underCap(input.openCounts.get(candidate.userId) ?? 0, input.loadCap),
  );

/**
 * The next assignee, or null when nobody is eligible.
 *
 * Skill matching is among the *eligible*: a skilled agent who is offline or at
 * cap does not keep a ticket waiting, it goes to whoever else may take it —
 * which is what "everyone if none match" means for the ticket in front of us.
 */
export const pickAssignee = (input: PickInput): string | null => {
  const eligible = eligibleCandidates(input);
  const tags = new Set(input.ticketTagIds);
  const skilled =
    input.mode === 'skill_based'
      ? eligible.filter((candidate) => candidate.skillTagIds.some((tagId) => tags.has(tagId)))
      : [];
  const pool = skilled.length > 0 ? skilled : eligible;

  return [...pool].sort(longestWaitingFirst)[0]?.userId ?? null;
};

import { z } from 'zod';
import { brandRoleSchema } from './principal.js';
import { presenceStatusSchema } from './realtime.js';
import { tagSchema } from './tags.js';
import { DEPARTMENT_NAME_MAX_LENGTH } from './ticketing.js';

/**
 * Assignment (M1-07, REQUIREMENTS §4.1, DOMAIN-RULES §12): how a department
 * hands its tickets to agents.
 *
 * ```
 * Department ── mode, load cap, auto-unassign, on_unassign
 * └── Agent in it ── in rotation?, skills (tags), open tickets
 * ```
 *
 * Two audiences read it. The Assignment tab of `Admin/Ticketing` reads and
 * writes the settings under `ticketing:manage`. The ticket workspace's
 * assignee picker reads {@link assignableAgentListSchema} under
 * `ticket:write`, which is why that shape carries a name and a count and
 * nothing that identifies a colleague beyond what the picker prints.
 */

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

/**
 * `manual` leaves new tickets unassigned. `round_robin` gives each one to the
 * online, in-rotation agent under their cap who has waited longest.
 * `skill_based` does the same among the agents whose skills match one of the
 * ticket's tags, and among everyone when none do.
 */
export const assignmentModeSchema = z.enum(['manual', 'round_robin', 'skill_based']);
export type AssignmentMode = z.infer<typeof assignmentModeSchema>;

/** DOMAIN-RULES §12: what a ticket does when its assignee can no longer work it. */
export const onUnassignSchema = z.enum(['round_robin', 'leave_unassigned']);
export type OnUnassign = z.infer<typeof onUnassignSchema>;

export const LOAD_CAP_MAX = 500;
export const AUTO_UNASSIGN_MINUTES_DEFAULT = 15;
export const AUTO_UNASSIGN_MINUTES_MAX = 1_440;
/** More skills than this on one agent in one department is a tag list, not a skill set. */
export const MAX_SKILLS_PER_AGENT = 50;

const loadCapSchema = z.int().min(1).max(LOAD_CAP_MAX);
const autoUnassignMinutesSchema = z.int().min(1).max(AUTO_UNASSIGN_MINUTES_MAX);

/** One row of the Assignment tab: a department and how it routes. */
export const departmentAssignmentSchema = z.object({
  departmentId: z.uuid(),
  name: z.string().min(1).max(DEPARTMENT_NAME_MAX_LENGTH),
  nameAr: z.string().min(1).max(DEPARTMENT_NAME_MAX_LENGTH).nullable(),
  mode: assignmentModeSchema,
  /** Open and escalated tickets per agent in this department. Null is no cap. */
  loadCap: loadCapSchema.nullable(),
  autoUnassignOffline: z.boolean(),
  autoUnassignAfterMinutes: autoUnassignMinutesSchema,
  onUnassign: onUnassignSchema,
  /** Agents in rotation who are online now. */
  agentsOnline: z.int().nonnegative(),
  /** Agents in rotation. */
  agentsInRotation: z.int().nonnegative(),
});
export type DepartmentAssignment = z.infer<typeof departmentAssignmentSchema>;

export const departmentAssignmentListSchema = z.object({
  departments: z.array(departmentAssignmentSchema),
});
export type DepartmentAssignmentList = z.infer<typeof departmentAssignmentListSchema>;

/**
 * Every field is optional and sending none is refused, for the reason
 * `departmentUpdateRequestSchema` gives: an empty PATCH would still write an
 * audit row saying somebody changed something.
 */
export const departmentAssignmentUpdateRequestSchema = z
  .object({
    mode: assignmentModeSchema.optional(),
    loadCap: loadCapSchema.nullable().optional(),
    autoUnassignOffline: z.boolean().optional(),
    autoUnassignAfterMinutes: autoUnassignMinutesSchema.optional(),
    onUnassign: onUnassignSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type DepartmentAssignmentUpdateRequest = z.infer<
  typeof departmentAssignmentUpdateRequestSchema
>;

// --------------------------------------------------------------------------
// Agents in a department
// --------------------------------------------------------------------------

/**
 * One row of "Agents in <department>". Anybody whose role reaches the
 * department and may work tickets is listed, in rotation or not, so the tab is
 * where somebody is put into it.
 */
export const assignmentAgentSchema = z.object({
  userId: z.uuid(),
  name: z.string().min(1),
  role: brandRoleSchema,
  presence: presenceStatusSchema,
  /** Open and escalated tickets assigned to them in this department. */
  openCount: z.int().nonnegative(),
  inRotation: z.boolean(),
  skills: z.array(tagSchema),
  /**
   * Whether the person asking may change this row. A Team Leader edits Agents
   * in the departments they lead and nobody above them (DOMAIN-RULES §1.2).
   */
  editable: z.boolean(),
});
export type AssignmentAgent = z.infer<typeof assignmentAgentSchema>;

export const assignmentAgentListSchema = z.object({
  departmentId: z.uuid(),
  loadCap: loadCapSchema.nullable(),
  agents: z.array(assignmentAgentSchema),
});
export type AssignmentAgentList = z.infer<typeof assignmentAgentListSchema>;

export const assignmentAgentUpdateRequestSchema = z
  .object({
    inRotation: z.boolean().optional(),
    /** The whole set, replacing the old one. Idempotent, like a reorder. */
    skillTagIds: z.array(z.uuid()).max(MAX_SKILLS_PER_AGENT).optional(),
  })
  .refine(
    (value) => value.inRotation !== undefined || value.skillTagIds !== undefined,
    'Send at least one field to change',
  );
export type AssignmentAgentUpdateRequest = z.infer<typeof assignmentAgentUpdateRequestSchema>;

export const assignmentDepartmentParamSchema = z.object({
  brandId: z.uuid(),
  departmentId: z.uuid(),
});
export type AssignmentDepartmentParam = z.infer<typeof assignmentDepartmentParamSchema>;

export const assignmentAgentParamSchema = assignmentDepartmentParamSchema.extend({
  userId: z.uuid(),
});
export type AssignmentAgentParam = z.infer<typeof assignmentAgentParamSchema>;

// --------------------------------------------------------------------------
// The assignee picker
// --------------------------------------------------------------------------

/**
 * Somebody the assignee picker may offer. An id, a name, whether they are
 * around and how loaded they are — no address and no role, because the route
 * is `ticket:write`, which every Agent holds, and the staff roster with its
 * addresses stays `staff:manage`.
 */
export const assignableAgentSchema = z.object({
  userId: z.uuid(),
  name: z.string().min(1),
  presence: presenceStatusSchema,
  openCount: z.int().nonnegative(),
});
export type AssignableAgent = z.infer<typeof assignableAgentSchema>;

export const assignableAgentListSchema = z.object({
  departmentId: z.uuid(),
  /** The department's cap, so the picker can say "8/8 at cap". Null is no cap. */
  loadCap: loadCapSchema.nullable(),
  agents: z.array(assignableAgentSchema),
});
export type AssignableAgentList = z.infer<typeof assignableAgentListSchema>;

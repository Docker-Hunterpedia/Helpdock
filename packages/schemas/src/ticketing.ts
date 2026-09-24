import { z } from 'zod';
import { localeSchema, timezoneSchema } from './brand.js';
import { ticketPrefixSchema } from './install.js';
import { brandRoleSchema } from './principal.js';

/**
 * How a brand's work is shaped and routed (M1-01): departments, the teams
 * inside them, and who is on a team.
 *
 * ```
 * Brand
 * └── Department (Billing, Technical, Sales)
 *     └── Team → members
 * ```
 *
 * A department is the unit a Team Leader leads, an Agent belongs to, and a
 * ticket is filed under (DOMAIN-RULES §1.2). A team is a subdivision of one
 * department used for assignment and for "assign to my team"; M1-07 is what
 * routes to it, M3 is what gives a department business hours.
 *
 * `departmentSchema` lives here rather than in `staff.ts` because departments
 * are a ticketing concept the staff screens borrow, not the other way round.
 * The richer {@link departmentSummarySchema} extends it, so a client that still
 * parses the small shape keeps working against the bigger response.
 */

// --------------------------------------------------------------------------
// Departments
// --------------------------------------------------------------------------

export const DEPARTMENT_NAME_MAX_LENGTH = 120;

/**
 * The department every brand starts with. A brand with none is supported, but
 * an operator who has just been told a brand is "one support desk" should find
 * one department in it rather than an empty picker on the first screen that
 * asks for one. The first-run wizard and `POST /api/install/brands` both use it.
 */
export const DEFAULT_DEPARTMENT_NAME = 'General';

const departmentNameSchema = z.string().trim().min(1).max(DEPARTMENT_NAME_MAX_LENGTH);

/**
 * The chip picker's options, and the smallest thing that identifies a
 * department. The staff screens read exactly this much.
 */
export const departmentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(DEPARTMENT_NAME_MAX_LENGTH),
});
export type Department = z.infer<typeof departmentSchema>;

export const departmentListSchema = z.object({ departments: z.array(departmentSchema) });
export type DepartmentList = z.infer<typeof departmentListSchema>;

/**
 * One row of the Departments tab. The counts are computed by the api because
 * the cell shows them: resolving them per row in the browser would mean the
 * table could render before it knew what it was showing.
 *
 * `nameAr` is the department's name in Arabic. It is optional — an install that
 * never serves Arabic should not be made to invent one — and the screen falls
 * back to `name` when it is null.
 */
export const departmentSummarySchema = departmentSchema.extend({
  nameAr: z.string().min(1).max(DEPARTMENT_NAME_MAX_LENGTH).nullable(),
  /** Position in the brand's list. Dense and zero-based after every reorder. */
  sortOrder: z.int().nonnegative(),
  /** The team a ticket goes to when no rule picks one. Null until one is set. */
  defaultTeamId: z.uuid().nullable(),
  /**
   * That team's name, resolved by the api. The list prints it on every row, and
   * a client that had to resolve it itself would need every department's teams
   * to draw one column.
   */
  defaultTeamName: z.string().min(1).nullable(),
  teamCount: z.int().nonnegative(),
  /** Distinct people across this department's teams, not the sum of the teams. */
  memberCount: z.int().nonnegative(),
});
export type DepartmentSummary = z.infer<typeof departmentSummarySchema>;

export const departmentSummaryListSchema = z.object({
  departments: z.array(departmentSummarySchema),
});
export type DepartmentSummaryList = z.infer<typeof departmentSummaryListSchema>;

export const departmentCreateRequestSchema = z.object({
  name: departmentNameSchema,
  nameAr: departmentNameSchema.nullish(),
});
export type DepartmentCreateRequest = z.infer<typeof departmentCreateRequestSchema>;

/**
 * Every field is optional and sending none is refused: a PATCH that changes
 * nothing would still write an audit row saying somebody changed something.
 *
 * `defaultTeamId` is nullable rather than merely optional, because "no default
 * team" is a value an editor has to be able to choose again.
 */
export const departmentUpdateRequestSchema = z
  .object({
    name: departmentNameSchema.optional(),
    nameAr: departmentNameSchema.nullable().optional(),
    defaultTeamId: z.uuid().nullable().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type DepartmentUpdateRequest = z.infer<typeof departmentUpdateRequestSchema>;

export const MAX_DEPARTMENTS_PER_BRAND = 200;

/**
 * The whole list in its new order. Sending every id rather than "move this one
 * to position 4" makes the request idempotent and makes two editors racing
 * resolve to one of the two orders rather than to a mixture of both.
 */
export const departmentReorderRequestSchema = z.object({
  departmentIds: z.array(z.uuid()).min(1).max(MAX_DEPARTMENTS_PER_BRAND),
});
export type DepartmentReorderRequest = z.infer<typeof departmentReorderRequestSchema>;

export const departmentParamSchema = z.object({
  brandId: z.uuid(),
  departmentId: z.uuid(),
});
export type DepartmentParam = z.infer<typeof departmentParamSchema>;

// --------------------------------------------------------------------------
// Teams
// --------------------------------------------------------------------------

export const TEAM_NAME_MAX_LENGTH = 120;

const teamNameSchema = z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH);

/**
 * Somebody on a team, as the team list names them.
 *
 * **No address.** The team list is `brand:read`, which an Agent and a Viewer
 * hold, and DOMAIN-RULES §1.2 gives those two roles nothing to manage: the
 * brand's roster with its addresses is `staff:manage` and stays there. A name
 * and a role are what a list of who is on a team has to print.
 */
export const teamMemberSchema = z.object({
  userId: z.uuid(),
  name: z.string().min(1),
  /** Their role in this brand, so the list can say who is a leader. */
  role: brandRoleSchema,
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

/**
 * Somebody the people picker may offer. It carries the address because two
 * colleagues share a name often enough that a picker without one is a guess —
 * and because the route that answers it is `staff:manage`, which is where
 * addresses already live.
 */
export const eligibleMemberSchema = teamMemberSchema.extend({
  email: z.string().min(1),
});
export type EligibleMember = z.infer<typeof eligibleMemberSchema>;

export const teamSchema = z.object({
  id: z.uuid(),
  departmentId: z.uuid(),
  name: z.string().min(1).max(TEAM_NAME_MAX_LENGTH),
  sortOrder: z.int().nonnegative(),
  members: z.array(teamMemberSchema),
});
export type Team = z.infer<typeof teamSchema>;

export const teamListSchema = z.object({ teams: z.array(teamSchema) });
export type TeamList = z.infer<typeof teamListSchema>;

export const teamCreateRequestSchema = z.object({ name: teamNameSchema });
export type TeamCreateRequest = z.infer<typeof teamCreateRequestSchema>;

export const teamUpdateRequestSchema = z.object({ name: teamNameSchema });
export type TeamUpdateRequest = z.infer<typeof teamUpdateRequestSchema>;

export const teamParamSchema = departmentParamSchema.extend({ teamId: z.uuid() });
export type TeamParam = z.infer<typeof teamParamSchema>;

export const teamMemberParamSchema = teamParamSchema.extend({ userId: z.uuid() });
export type TeamMemberParam = z.infer<typeof teamMemberParamSchema>;

export const teamMemberAddRequestSchema = z.object({ userId: z.uuid() });
export type TeamMemberAddRequest = z.infer<typeof teamMemberAddRequestSchema>;

/**
 * Who the people picker may offer: staff whose own department scope covers this
 * department, so a team can never contain somebody who cannot see the tickets
 * it would be assigned (DOMAIN-RULES §1.2).
 */
export const eligibleMemberListSchema = z.object({ members: z.array(eligibleMemberSchema) });
export type EligibleMemberList = z.infer<typeof eligibleMemberListSchema>;

// --------------------------------------------------------------------------
// Refusals
// --------------------------------------------------------------------------

/**
 * Why a ticketing-settings action was refused, when the status alone is too
 * coarse to turn into a sentence. The api sends the code; the screen picks the
 * catalog key, so no user-facing English crosses the boundary.
 */
export const ticketingRefusalSchema = z.enum([
  /** The actor leads other departments, or none (403). */
  'out-of-scope',
  /** A brand has to keep one department for tickets to be filed under (409). */
  'last-department',
  /** Tickets still reference it, so deleting would orphan them (409). */
  'department-in-use',
  /** Another department or team of this brand already has that name (409). */
  'name-taken',
  /** The person holds no role in this brand that reaches this department (409). */
  'not-eligible',
  /** A seeded status may be renamed and recoloured, never deleted (409, M1-08). */
  'status-is-system',
  /** The brand's default status; another has to take the role first (409, M1-08). */
  'status-is-default',
  /** A seeded status's system state and flags are what code refers to it by (409, M1-08). */
  'status-state-fixed',
  /** A new or reopened ticket lands in the default, so it has to be open-like (409, M1-08). */
  'default-must-be-open',
  /** Rows already carry values for this field, so its type cannot move (409). */
  'field-in-use',
  /** Rows still carry that option; send `force` to clear them with it (409). */
  'option-in-use',
  /** Not a valid address, domain, phone number or Telegram chat id (400, M1-11). */
  'sender-invalid',
  /** The brand sends from that address or domain, so it cannot block it (409, M1-11). */
  'sender-is-own',
  /** That sender is already on the block list (409, M1-11). */
  'sender-already-blocked',
]);
export type TicketingRefusal = z.infer<typeof ticketingRefusalSchema>;

// --------------------------------------------------------------------------
// Additional brands
// --------------------------------------------------------------------------

/**
 * What `POST /api/install/brands` accepts. It is deliberately the first-run
 * wizard's brand step minus the help-center domain: an install admin adding a
 * second brand is doing the same thing the wizard did, and a second spelling of
 * "make a brand" would be a second set of rules to keep in step.
 *
 * The prefix and the time zone are the wizard's own field rules, imported
 * rather than restated: a value the wizard accepts and this route refuses would
 * be two answers to one question.
 */
export const brandCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prefix: ticketPrefixSchema,
  defaultLocale: localeSchema,
  timezone: timezoneSchema,
  /** The department the new brand starts with. Named so it is never a surprise. */
  firstDepartmentName: departmentNameSchema.default(DEFAULT_DEPARTMENT_NAME),
});
export type BrandCreateRequest = z.infer<typeof brandCreateRequestSchema>;

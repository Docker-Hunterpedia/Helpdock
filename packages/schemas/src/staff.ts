import { z } from 'zod';
import { passwordSchema, staffRoleSchema } from './auth.js';
import { localeSchema } from './brand.js';
import { departmentSchema } from './ticketing.js';

/**
 * The wire contract for staff and roles (M0-06): the list an administrator
 * reads, the invite an administrator sends, the invite a stranger accepts, and
 * the four things a person may change about their own account.
 *
 * It speaks the admin app's spelling of a role — `teamLeader`, not
 * `team_leader` — for the same reason `sessionUserSchema` does: the screens
 * were built against it, and `session-view.ts` in the api is the one place the
 * two spellings meet.
 *
 * **Department scope.** DOMAIN-RULES §1.1: `departmentIds` is `'all'` for an
 * Admin, and for a Team Leader or Viewer with no department restriction; an
 * Agent always carries an explicit list. On the wire a request sends a plain
 * array and the api applies that rule:
 *
 * | Role | Empty array means |
 * |---|---|
 * | Admin | every department, whatever was sent |
 * | Team Leader, Viewer | every department — the unrestricted case of §1.1 |
 * | Agent | no departments, so the account sees no tickets until one is added |
 *
 * Fail-closed is the point of the last row: an Agent with nothing assigned must
 * see nothing, never everything.
 */

/**
 * Why a staff action was refused, when the status alone is too coarse to turn
 * into a sentence. The api sends the code; the screen picks the catalog key,
 * so no user-facing English crosses the boundary (packages/i18n README).
 */
export const staffRefusalSchema = z.enum([
  /** Acting on your own membership (409). */
  'self',
  /** The target, or the role being assigned, is outside the actor's reach (403). */
  'out-of-scope',
  /** `roles.viewerEnabled` is off (409). */
  'viewer-disabled',
  /** The install would be left with no install admin (409). */
  'last-install-admin',
]);
export type StaffRefusal = z.infer<typeof staffRefusalSchema>;

// --------------------------------------------------------------------------
// Departments
// --------------------------------------------------------------------------

/**
 * The chip picker's options. The shape itself lives in `ticketing.ts`, which is
 * where departments are defined and managed (M1-01); the staff screens read
 * this subset of it and nothing more.
 */

/**
 * `'all'` or the explicit list, as the table cell and the chip field read it.
 * Named apart from `departmentScopeSchema` in `principal.ts`, which is the same
 * idea as bare ids: this one carries the names a screen prints.
 */
export const staffDepartmentScopeSchema = z.union([z.array(departmentSchema), z.literal('all')]);
export type StaffDepartmentScope = z.infer<typeof staffDepartmentScopeSchema>;

// --------------------------------------------------------------------------
// The staff list
// --------------------------------------------------------------------------

/** DOMAIN-RULES §12, as a state the row is drawn in. */
export const staffStatusSchema = z.enum(['invited', 'active', 'deactivated']);
export type StaffStatus = z.infer<typeof staffStatusSchema>;

/**
 * One row of the staff table. Departments arrive resolved to names because the
 * cell shows names, and resolving them per row in the browser would mean the
 * table could render before it knew what it was showing.
 */
export const staffMemberSchema = z.object({
  userId: z.uuid(),
  name: z.string().min(1),
  email: z.string().min(1),
  role: staffRoleSchema,
  departments: staffDepartmentScopeSchema,
  status: staffStatusSchema,
  twoFactorEnabled: z.boolean(),
  installAdmin: z.boolean(),
  /**
   * Derived from the refresh families this account holds, so it is the last
   * time a browser of theirs actually spoke to the api. Null when none does.
   */
  lastActiveAt: z.iso.datetime().nullable(),
  /** Both set while `status` is `invited`, and null otherwise. */
  invitedAt: z.iso.datetime().nullable(),
  invitationExpiresAt: z.iso.datetime().nullable(),
  deactivatedAt: z.iso.datetime().nullable(),
  /** True for the person reading the list: their own row offers no actions. */
  self: z.boolean(),
});
export type StaffMember = z.infer<typeof staffMemberSchema>;

export const staffListSchema = z.object({
  staff: z.array(staffMemberSchema),
  /** `roles.viewerEnabled`. Off hides the Viewer card and disables the option. */
  viewerEnabled: z.boolean(),
});
export type StaffList = z.infer<typeof staffListSchema>;

/** Trimmed by the api, so `?search=  ` is the same request as no search at all. */
export const staffSearchQuerySchema = z.object({
  search: z.string().max(200).optional(),
});
export type StaffSearchQuery = z.infer<typeof staffSearchQuerySchema>;

// --------------------------------------------------------------------------
// Inviting, and changing somebody
// --------------------------------------------------------------------------

/** An install may have no departments yet; M1-01 is what creates them. */
export const departmentIdsSchema = z.array(z.uuid()).max(100);

export const staffInviteRequestSchema = z.object({
  email: z.email().max(320),
  role: staffRoleSchema,
  departmentIds: departmentIdsSchema,
});
export type StaffInviteRequest = z.infer<typeof staffInviteRequestSchema>;

/**
 * Both fields are optional, and sending neither is refused: a PATCH that
 * changes nothing would still revoke every session the target holds, which is
 * a surprising amount of damage for an empty body to do.
 */
export const staffUpdateRequestSchema = z
  .object({
    role: staffRoleSchema.optional(),
    departmentIds: departmentIdsSchema.optional(),
  })
  .refine(
    (value) => value.role !== undefined || value.departmentIds !== undefined,
    'Send a role, departments, or both',
  );
export type StaffUpdateRequest = z.infer<typeof staffUpdateRequestSchema>;

export const staffUserIdParamSchema = z.object({ userId: z.uuid() });
export type StaffUserIdParam = z.infer<typeof staffUserIdParamSchema>;

export const brandStaffParamSchema = z.object({ brandId: z.uuid(), userId: z.uuid() });
export type BrandStaffParam = z.infer<typeof brandStaffParamSchema>;

// --------------------------------------------------------------------------
// Accepting an invite
// --------------------------------------------------------------------------

/**
 * What the public invite screen may know: enough to say who invited whom and
 * to what, and nothing that would make the link worth guessing. There is no
 * user id here, and no brand id — a stranger holding the token learns a brand
 * name and an inviter's name, which the email they were sent already told them.
 */
export const publicInviteSchema = z.object({
  email: z.string().min(1),
  inviterName: z.string().min(1),
  brandName: z.string().min(1),
  role: staffRoleSchema,
  /** Names only, in the order the invite set them. Empty means every department. */
  departments: z.array(z.string().min(1)),
  expiresAt: z.iso.datetime(),
});
export type PublicInvite = z.infer<typeof publicInviteSchema>;

export const inviteAcceptRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  password: passwordSchema,
  locale: localeSchema,
});
export type InviteAcceptRequest = z.infer<typeof inviteAcceptRequestSchema>;

export const inviteTokenParamSchema = z.object({ token: z.string().min(1).max(200) });
export type InviteTokenParam = z.infer<typeof inviteTokenParamSchema>;

// --------------------------------------------------------------------------
// The account a person owns
// --------------------------------------------------------------------------

export const profileSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  email: z.string().min(1),
  locale: localeSchema,
  twoFactorEnabled: z.boolean(),
  /** How many recovery codes are still unspent, so the page can say "3 left". */
  recoveryCodesLeft: z.number().int().nonnegative(),
  /** `auth.require2fa`. On, the disable button is not offered. */
  twoFactorRequired: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;

export const profileUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    locale: localeSchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.locale !== undefined,
    'Send a name, a language, or both',
  );
export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;

export const passwordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

/** Turning the second factor off, and re-drawing the recovery codes, both cost a live code. */
export const totpCodeRequestSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpCodeRequest = z.infer<typeof totpCodeRequestSchema>;

/**
 * One browser, as the security page lists it. The family id is the handle for
 * signing that one out; it is already in this browser's own cookie, so naming
 * it here gives a caller nothing it did not have.
 */
export const staffSessionSchema = z.object({
  familyId: z.uuid(),
  /** Truncated by the api to 120 characters, and absent when the browser sent none. */
  userAgent: z.string(),
  startedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  /** The one this request arrived on. The page labels it and never offers to end it alone. */
  current: z.boolean(),
});
export type StaffSession = z.infer<typeof staffSessionSchema>;

export const staffSessionListSchema = z.object({ sessions: z.array(staffSessionSchema) });
export type StaffSessionList = z.infer<typeof staffSessionListSchema>;

export const sessionFamilyParamSchema = z.object({ family: z.uuid() });
export type SessionFamilyParam = z.infer<typeof sessionFamilyParamSchema>;

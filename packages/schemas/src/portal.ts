import { z } from 'zod';

/**
 * The customer portal's shared vocabulary (M21-01, ADR 0059 and 0060). The
 * enums mirror the two Postgres enums of the same names; the rule that turns
 * them into what a customer sees is one pure function so the api, the tests and
 * the admin screens cannot disagree about it.
 */

/** `accounts.portal_visibility`: whose tickets the members of an account see. */
export const portalVisibilitySchema = z.enum(['own', 'managers', 'all']);
export type PortalVisibility = z.infer<typeof portalVisibilitySchema>;

/** `contacts.account_role`. */
export const accountRoleSchema = z.enum(['member', 'manager']);
export type AccountRole = z.infer<typeof accountRoleSchema>;

/** What a signed-in customer's queries may reach: their own tickets, or their account's too. */
export const customerSeesSchema = z.enum(['own', 'account']);
export type CustomerSees = z.infer<typeof customerSeesSchema>;

/**
 * `sees` for the `customer` principal (ADR 0060 §5), recomputed on every
 * request so a change of setting or role takes effect at once. No account means
 * own tickets whatever else is true: the account's name is what the policy
 * matches on.
 */
export const customerSees = (input: {
  readonly hasAccount: boolean;
  readonly visibility: PortalVisibility;
  readonly role: AccountRole;
}): CustomerSees => {
  if (!input.hasAccount) {
    return 'own';
  }

  switch (input.visibility) {
    case 'all':
      return 'account';
    case 'managers':
      return input.role === 'manager' ? 'account' : 'own';
    case 'own':
      return 'own';
  }
};

/**
 * `brands.settings.portal` (D-63, D-65). Off by default: a brand that never
 * heard of the portal keeps behaving as before.
 */
export const portalSettingsSchema = z.object({
  /** The portal answers at all. */
  enabled: z.boolean().default(false),
  /** An address with no contact may sign in, and the first sign-in creates the contact. */
  newCustomers: z.boolean().default(false),
  /** The departments whose tickets the portal shows; every department by default. */
  departmentIds: z.union([z.array(z.uuid()), z.literal('all')]).default('all'),
});
export type PortalSettings = z.infer<typeof portalSettingsSchema>;

// --------------------------------------------------------------------------
// The sign-in pages' own inputs (M21-02)
// --------------------------------------------------------------------------

/** What the `/sign-in` form posts. The address is validated by the page, so a bad one is a field error, not a 400. */
export const portalSignInFormSchema = z.object({
  email: z.string().max(500).default(''),
  lang: z.string().max(10).optional(),
  /** Where to land after Continue; checked against the allow-list by `safePortalNext`. */
  next: z.string().max(300).optional(),
  csrf: z.string().max(200).default(''),
  /** The built-in check's solution (ADR 0052). */
  hd_pow: z.string().max(8192).optional(),
});
export type PortalSignInForm = z.infer<typeof portalSignInFormSchema>;

/** What the Continue button posts. */
export const portalConfirmFormSchema = z.object({
  token: z.string().max(200).default(''),
  lang: z.string().max(10).optional(),
  next: z.string().max(300).optional(),
  csrf: z.string().max(200).default(''),
});
export type PortalConfirmForm = z.infer<typeof portalConfirmFormSchema>;

/** Sign out and Sign out everywhere carry the CSRF token only. */
export const portalSessionFormSchema = z.object({
  csrf: z.string().max(200).default(''),
  lang: z.string().max(10).optional(),
});
export type PortalSessionForm = z.infer<typeof portalSessionFormSchema>;

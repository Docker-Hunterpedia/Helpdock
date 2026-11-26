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

// --------------------------------------------------------------------------
// The staff side (M21-06)
// --------------------------------------------------------------------------

/**
 * `PUT /api/brands/:brandId/portal-settings`: the whole `settings.portal` block
 * and nothing else. "Only these departments" needs at least one, and a list
 * never repeats an id; that every id is a department of the brand is the
 * service's check, because only the database knows.
 */
export const portalSettingsUpdateSchema = z
  .strictObject({
    enabled: z.boolean(),
    newCustomers: z.boolean(),
    departmentIds: z.union([z.array(z.uuid()).min(1).max(200), z.literal('all')]),
  })
  .refine(
    (value) =>
      value.departmentIds === 'all' ||
      new Set(value.departmentIds).size === value.departmentIds.length,
    { message: 'A department is listed once', path: ['departmentIds'] },
  );
export type PortalSettingsUpdate = z.infer<typeof portalSettingsUpdateSchema>;

/** `PUT /api/brands/:brandId/accounts/:accountId/portal`. */
export const accountPortalUpdateSchema = z
  .strictObject({
    visibility: portalVisibilitySchema,
    managerContactIds: z.array(z.uuid()).max(200),
  })
  .refine((value) => new Set(value.managerContactIds).size === value.managerContactIds.length, {
    message: 'A manager is listed once',
    path: ['managerContactIds'],
  });
export type AccountPortalUpdate = z.infer<typeof accountPortalUpdateSchema>;

/** One member of an account on the account page's "Customer portal" section. */
export const accountPortalMemberSchema = z.strictObject({
  contactId: z.uuid(),
  name: z.string(),
  /** The address the person signs in with, when they have a verified one. */
  email: z.string().nullable(),
  role: accountRoleSchema,
  /** The most recent portal activity of the contact; null when they never signed in. */
  lastSignInAt: z.iso.datetime().nullable(),
});
export type AccountPortalMember = z.infer<typeof accountPortalMemberSchema>;

export const accountPortalSchema = z.strictObject({
  visibility: portalVisibilitySchema,
  members: z.array(accountPortalMemberSchema).max(500),
});
export type AccountPortal = z.infer<typeof accountPortalSchema>;

/** Why a contact sees what it sees; one word each, so the card can explain it. */
export const portalSeesBecauseSchema = z.enum([
  'no-account',
  'own',
  'manager',
  'member-not-manager',
  'all',
]);
export type PortalSeesBecause = z.infer<typeof portalSeesBecauseSchema>;

/** `customerSees`, with the reason beside the answer. */
export const portalSeesBecause = (input: {
  readonly hasAccount: boolean;
  readonly visibility: PortalVisibility;
  readonly role: AccountRole;
}): PortalSeesBecause => {
  if (!input.hasAccount) {
    return 'no-account';
  }

  switch (input.visibility) {
    case 'all':
      return 'all';
    case 'managers':
      return input.role === 'manager' ? 'manager' : 'member-not-manager';
    case 'own':
      return 'own';
  }
};

/**
 * One browser a customer is signed in on. Never the token hash, an address or
 * the raw user agent: a family name, when it was last used and the help center
 * host.
 */
export const contactPortalSessionSchema = z.strictObject({
  id: z.uuid(),
  userAgentFamily: z.string().nullable(),
  lastSeenAt: z.iso.datetime(),
  host: z.string(),
});
export type ContactPortalSession = z.infer<typeof contactPortalSessionSchema>;

/** `GET /api/brands/:brandId/contacts/:contactId/portal`. */
export const contactPortalAccessSchema = z.strictObject({
  signedIn: z.boolean(),
  /** The address of the most recent live session; null when there is none. */
  signsInWith: z.string().nullable(),
  sees: customerSeesSchema,
  seesBecause: portalSeesBecauseSchema,
  sessions: z.array(contactPortalSessionSchema).max(100),
});
export type ContactPortalAccess = z.infer<typeof contactPortalAccessSchema>;

/** `POST .../portal/sign-out`: how many sessions ended. */
export const contactPortalSignOutSchema = z.strictObject({ ended: z.int().nonnegative() });
export type ContactPortalSignOut = z.infer<typeof contactPortalSignOutSchema>;

/** `PUT /api/brands/:brandId/tickets/:ticketId/portal-private`. */
export const ticketPortalPrivateUpdateSchema = z.strictObject({ private: z.boolean() });
export type TicketPortalPrivateUpdate = z.infer<typeof ticketPortalPrivateUpdateSchema>;

/**
 * The details panel's "Customer portal" card: whether the ticket is private to
 * its requester and who can see it in the portal now. `company` is null when the
 * ticket is private, or the requester has no account, or the account shares
 * nothing.
 */
export const ticketPortalViewSchema = z.strictObject({
  private: z.boolean(),
  requester: z.string().nullable(),
  company: z.strictObject({ name: z.string(), audience: z.enum(['all', 'managers']) }).nullable(),
});
export type TicketPortalView = z.infer<typeof ticketPortalViewSchema>;

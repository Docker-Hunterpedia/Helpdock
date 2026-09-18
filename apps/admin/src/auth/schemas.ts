import { z } from 'zod';

/**
 * The wire contract between the admin app and the auth service. M0-05 (#8)
 * implements these endpoints and moves this file to `packages/schemas` so the
 * api validates its responses against the same shapes; until then they live
 * here and `MockAuthApi` is the only implementation.
 */

export const brandSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** Help center host for this brand, shown under the sign-in heading. */
  domain: z.string().min(1),
  /** `HD` in `HD-1042` (REQUIREMENTS §3). Fixed at brand creation. */
  ticketPrefix: z.string().min(1).max(8),
});
export type Brand = z.infer<typeof brandSchema>;

const staffRoles = ['admin', 'teamLeader', 'agent', 'viewer'] as const;
export const staffRoleSchema = z.enum(staffRoles);
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const sessionUserSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  email: z.email(),
  /** Role in the current brand (DOMAIN-RULES §1.1). */
  role: staffRoleSchema,
  /** Install admins are shown as such instead of by brand role (DESIGN §6.5). */
  installAdmin: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const navCountsSchema = z.record(z.string(), z.number().int().nonnegative());

export const sessionSchema = z.object({
  user: sessionUserSchema,
  /** Every brand this user can work in; the switcher lists them. */
  brands: z.array(brandSchema).min(1),
  currentBrandId: z.uuid(),
  /**
   * Counts beside the nav items. Optional because nothing counts yet: the api
   * starts sending them with the ticketing milestone, and the sidebar renders a
   * count only for the keys it receives.
   */
  navCounts: navCountsSchema.optional(),
});
export type Session = z.infer<typeof sessionSchema>;

export const signInRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

export const magicLinkRequestSchema = z.object({ email: z.email() });

/**
 * Either the session, or the id of a second-factor challenge to be answered by
 * `POST /auth/totp`. Two-factor is required on this install (DESIGN artboard
 * `Admin/Login`), so password sign-in normally returns the second shape.
 */
export const signInResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), session: sessionSchema }),
  z.object({ kind: z.literal('totp-required'), challengeId: z.string().min(1), email: z.email() }),
]);
export type SignInResult = z.infer<typeof signInResultSchema>;

export const totpRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  trustDevice: z.boolean(),
});

export const recoveryCodeRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1),
});

const oauthProviders = ['google', 'github'] as const;
export const oauthProviderSchema = z.enum(oauthProviders);
export type OauthProvider = z.infer<typeof oauthProviderSchema>;

/**
 * Every failure the screens have to tell apart. The api returns the code; the
 * screen picks the catalog key, so no user-facing English crosses this boundary
 * (packages/i18n README).
 */
const authErrorCodes = [
  'invalid-credentials',
  'totp-mismatch',
  'totp-locked',
  'challenge-expired',
  'recovery-invalid',
  'unavailable',
] as const;
export const authErrorCodeSchema = z.enum(authErrorCodes);
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

export const authErrorSchema = z.object({
  code: authErrorCodeSchema,
  /** Present on `totp-mismatch`: how many tries are left before the lock. */
  attemptsLeft: z.number().int().nonnegative().optional(),
});
export type AuthErrorBody = z.infer<typeof authErrorSchema>;

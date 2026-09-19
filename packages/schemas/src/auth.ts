import { z } from 'zod';
import { brandMembershipSchema } from './principal.js';

/**
 * The wire contract between the admin app and the auth service (M0-05), plus
 * the payloads the api signs or stores and nobody else ever sees.
 *
 * It lives here because both sides parse the same shapes: `apps/admin` reads
 * the responses, `apps/api` declares them as output DTOs. The client-facing
 * half started life in `apps/admin/src/auth/schemas.ts` (M0-07) and is
 * unchanged in shape, except for the `totp-enrolment-required` result that an
 * install with `auth.require2fa` on produces.
 */

// --------------------------------------------------------------------------
// The session as a signed-in admin sees it
// --------------------------------------------------------------------------

/**
 * A brand in the switcher. Deliberately not `brandSchema` from `./brand.js`:
 * that one is the brand row, this one is the handful of fields the chrome
 * shows before any brand-scoped screen has loaded.
 */
export const sessionBrandSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** Help center host for this brand, shown under the sign-in heading. */
  domain: z.string().min(1),
  /** `HD` in `HD-1042` (REQUIREMENTS §3). Fixed at brand creation. */
  ticketPrefix: z.string().min(1).max(8),
});
export type SessionBrand = z.infer<typeof sessionBrandSchema>;

/**
 * The roles of DOMAIN-RULES §1.2 as the admin app spells them. The database and
 * the principal use `team_leader`; this is the same set in the casing the
 * screens were built against, and the api maps between the two in one place.
 */
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
  brands: z.array(sessionBrandSchema).min(1),
  currentBrandId: z.uuid(),
  /**
   * Counts beside the nav items. Optional because nothing counts yet: the api
   * starts sending them with the ticketing milestone, and the sidebar renders a
   * count only for the keys it receives.
   */
  navCounts: navCountsSchema.optional(),
});
export type Session = z.infer<typeof sessionSchema>;

// --------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------

export const signInRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

export const magicLinkRequestSchema = z.object({ email: z.email() });
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

export const totpRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  trustDevice: z.boolean(),
});
export type TotpRequest = z.infer<typeof totpRequestSchema>;

export const recoveryCodeRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1),
});
export type RecoveryCodeRequest = z.infer<typeof recoveryCodeRequestSchema>;

/**
 * The one-time code a magic link or an OAuth callback hands the browser in the
 * query string, exchanged here for the access token. The token itself never
 * travels in a URL, so it never lands in browser history, a referrer header or
 * a proxy log (DOMAIN-RULES §4.6).
 */
export const exchangeRequestSchema = z.object({ code: z.string().min(1) });
export type ExchangeRequest = z.infer<typeof exchangeRequestSchema>;

export const passwordForgotRequestSchema = z.object({ email: z.email() });
export type PasswordForgotRequest = z.infer<typeof passwordForgotRequestSchema>;

/**
 * Twelve characters is the floor NIST SP 800-63B sets for a user-chosen secret
 * when no composition rules are imposed, and none are imposed here.
 */
export const PASSWORD_MIN_LENGTH = 12;
/** Argon2 hashes any length; the cap is what stops a body from becoming a CPU bill. */
export const PASSWORD_MAX_LENGTH = 200;

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const passwordResetRequestSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const totpConfirmRequestSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequestSchema>;

// --------------------------------------------------------------------------
// Responses
// --------------------------------------------------------------------------

const oauthProviders = ['google', 'github'] as const;
export const oauthProviderSchema = z.enum(oauthProviders);
export type OauthProvider = z.infer<typeof oauthProviderSchema>;
export const OAUTH_PROVIDERS: readonly OauthProvider[] = oauthProviders;

/**
 * Which ways in this install offers, so the sign-in screen hides a provider
 * button rather than showing one that answers "not configured". It is public:
 * the answer is the same for everybody and is needed before anyone signs in.
 */
export const authMethodsSchema = z.object({
  password: z.boolean(),
  magicLink: z.boolean(),
  oauth: z.record(oauthProviderSchema, z.boolean()),
});
export type AuthMethods = z.infer<typeof authMethodsSchema>;

/** Seconds an access token stays valid, so the client can refresh before it expires. */
export const accessTokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
});

/**
 * What the api answers when a sign-in completes: the session for the screens
 * and the access token for the fetch wrapper. The refresh token is not here —
 * it is an `httpOnly` cookie, which is the whole point of it.
 */
export const authSessionResponseSchema = accessTokenSchema.extend({ session: sessionSchema });
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

/**
 * `POST /api/auth/sign-in` on the wire. Either the session, the id of a
 * second-factor challenge to answer at `POST /api/auth/totp`, or — when the
 * install requires 2FA and this account has none — the enrolment that has to
 * happen first (M0-06 builds that screen).
 */
export const signInResponseSchema = z.discriminatedUnion('kind', [
  authSessionResponseSchema.extend({ kind: z.literal('session') }),
  z.object({ kind: z.literal('totp-required'), challengeId: z.string().min(1), email: z.email() }),
  z.object({ kind: z.literal('totp-enrolment-required'), challengeId: z.string().min(1) }),
]);
export type SignInResponse = z.infer<typeof signInResponseSchema>;

/**
 * The same three outcomes as the admin's `AuthApi` reports them. The access
 * token is missing on purpose: `HttpAuthApi` keeps it in memory and no screen
 * ever holds one, so no screen can put it somewhere that persists.
 */
export const signInResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), session: sessionSchema }),
  z.object({ kind: z.literal('totp-required'), challengeId: z.string().min(1), email: z.email() }),
  z.object({ kind: z.literal('totp-enrolment-required'), challengeId: z.string().min(1) }),
]);
export type SignInResult = z.infer<typeof signInResultSchema>;

/** What `POST /api/auth/totp/enrol` returns for the QR the profile screen draws (M0-06). */
export const totpEnrolmentSchema = z.object({
  /** `otpauth://totp/…`, which is what a QR code encodes. */
  uri: z.string().min(1),
  /** The same secret in base32, for typing in by hand when a camera is not an option. */
  secret: z.string().min(1),
});
export type TotpEnrolment = z.infer<typeof totpEnrolmentSchema>;

/** Shown once, at enrolment, and never again: only their hashes are stored. */
export const recoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string().min(1)) });
export type RecoveryCodes = z.infer<typeof recoveryCodesSchema>;

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
  'no-account',
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

// --------------------------------------------------------------------------
// Server-only payloads
// --------------------------------------------------------------------------

/**
 * The access token's claims (ARCHITECTURE §7). They carry everything the
 * permission guard needs, so verifying one touches no database: `sub` is the
 * user, `sid` the session, `fam` the refresh family, and `brands` the same
 * membership map the principal has.
 *
 * A role change does not rewrite an issued token. It revokes the family, so the
 * next refresh fails and the claims are at most one access-token lifetime
 * stale — the ten minutes DOMAIN-RULES §1.6 allows for.
 */
export const sessionClaimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  fam: z.uuid(),
  brands: z.record(z.uuid(), brandMembershipSchema),
  installAdmin: z.boolean(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

/** The refresh cookie's value: the family it belongs to and the token itself. */
export const sessionCookiePayloadSchema = z.object({
  fam: z.uuid(),
  token: z.string().min(1),
});
export type SessionCookiePayload = z.infer<typeof sessionCookiePayloadSchema>;

/**
 * What a single-use emailed token stands for while it sits in Redis, keyed by
 * the token's hash. `purpose` is part of the record and not only of the key
 * prefix, so a magic link can never be spent as a password reset.
 */
export const emailTokenPurposeSchema = z.enum(['magic-link', 'password-reset', 'invite']);
export type EmailTokenPurpose = z.infer<typeof emailTokenPurposeSchema>;

export const magicLinkTokenPayloadSchema = z.object({
  purpose: z.literal('magic-link'),
  userId: z.uuid(),
  email: z.email(),
  issuedAt: z.number().int(),
});
export type MagicLinkTokenPayload = z.infer<typeof magicLinkTokenPayloadSchema>;

export const passwordResetTokenPayloadSchema = z.object({
  purpose: z.literal('password-reset'),
  userId: z.uuid(),
  email: z.email(),
  issuedAt: z.number().int(),
});
export type PasswordResetTokenPayload = z.infer<typeof passwordResetTokenPayloadSchema>;

/**
 * The staff invite of DOMAIN-RULES §12: single-use, seven days, with the role
 * and departments already decided. M0-06 sends and spends these; the shape is
 * declared here so the two milestones cannot disagree about it.
 */
export const inviteTokenPayloadSchema = z.object({
  purpose: z.literal('invite'),
  userId: z.uuid(),
  email: z.email(),
  brandId: z.uuid(),
  role: brandMembershipSchema.shape.role,
  departmentIds: brandMembershipSchema.shape.departmentIds,
  issuedAt: z.number().int(),
});
export type InviteTokenPayload = z.infer<typeof inviteTokenPayloadSchema>;

export const emailTokenPayloadSchema = z.discriminatedUnion('purpose', [
  magicLinkTokenPayloadSchema,
  passwordResetTokenPayloadSchema,
  inviteTokenPayloadSchema,
]);
export type EmailTokenPayload = z.infer<typeof emailTokenPayloadSchema>;

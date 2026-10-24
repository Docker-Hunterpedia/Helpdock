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
  /**
   * M14-01: whether shortcuts without a modifier answer for this person (see
   * `keyboardPreferencesSchema`). In the session so the shell knows it before
   * it draws, rather than taking letters until a second read answers (WCAG
   * 2.1.4). The api always sends it; absent counts as on, which is the
   * default (D-32) and what a session without the field always meant.
   */
  singleKeyShortcuts: z.boolean().optional(),
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

/**
 * 200 characters is what `inviteTokenParamSchema` allows: far more than the
 * 32-byte token encodes to, far less than a body that would cost anything to
 * hash.
 */
const magicLinkTokenSchema = z.string().min(1).max(200);

/**
 * The body of the confirm screen's two calls, `/magic-link/preview` and
 * `/magic-link/consume` (M9-01 F6). The token travels in JSON rather than in a
 * path, so it never reaches a request log.
 */
export const magicLinkTokenRequestSchema = z.object({ token: magicLinkTokenSchema });
export type MagicLinkTokenRequest = z.infer<typeof magicLinkTokenRequestSchema>;

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

/**
 * Enrolment before there is a session: an account that must have a second
 * factor and has none gets an `enrolment` challenge instead of a session
 * (`totp-enrolment-required`), and spends it here. The challenge stands in for
 * the session the authenticated `/totp/enrol` and `/totp/confirm` would need.
 */
export const enrolmentStartRequestSchema = z.object({ challengeId: z.string().min(1) });
export type EnrolmentStartRequest = z.infer<typeof enrolmentStartRequestSchema>;

export const enrolmentConfirmRequestSchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});
export type EnrolmentConfirmRequest = z.infer<typeof enrolmentConfirmRequestSchema>;

// --------------------------------------------------------------------------
// Paths and query strings
// --------------------------------------------------------------------------

/**
 * The `:token` segment of a sign-in link sent before the confirm screen
 * existed. It bounds the segment and nothing else: the route only forwards the
 * token to the screen, and an unknown one has to land there rather than on a
 * 400.
 */
export const magicLinkTokenParamSchema = z.object({ token: magicLinkTokenSchema });
export type MagicLinkTokenParam = z.infer<typeof magicLinkTokenParamSchema>;

/**
 * The `:provider` segment of the two OAuth routes, as a *shape*. Which
 * providers exist is `oauthProviderSchema`, and the handler applies that itself
 * rather than leaving it to a pipe: both routes answer a browser with a
 * redirect, and a pipe can only answer with a body. An unknown provider is
 * therefore `no-account` on a screen, not a 400 nobody can read.
 */
export const oauthProviderParamSchema = z.object({ provider: z.string().min(1).max(32) });
export type OauthProviderParam = z.infer<typeof oauthProviderParamSchema>;

/**
 * What a provider puts in the query string when it sends the browser back.
 * Both are optional because a refusal — or a person who declined on the consent
 * screen — arrives with neither, and that case is a screen too. Anything else
 * the provider appends is dropped here rather than reaching the handler.
 */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(4096).optional(),
});
export type OauthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;

/**
 * What connecting or disconnecting a Google or GitHub account costs from inside
 * a session (1.0.1): the current password or a live authenticator code, one of
 * the two. A session proves somebody signed in, not who is at the keyboard now.
 */
export const oauthStepUpRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .refine(
    (value) => (value.currentPassword === undefined) !== (value.code === undefined),
    'Send the current password or an authentication code, and only one of them',
  );
export type OauthStepUpRequest = z.infer<typeof oauthStepUpRequestSchema>;

// --------------------------------------------------------------------------
// Responses
// --------------------------------------------------------------------------

const oauthProviders = ['google', 'microsoft', 'github'] as const;
export const oauthProviderSchema = z.enum(oauthProviders);
export type OauthProvider = z.infer<typeof oauthProviderSchema>;
export const OAUTH_PROVIDERS: readonly OauthProvider[] = oauthProviders;

/** Where the browser goes to connect a provider account; the api has stored the state. */
export const oauthConnectStartSchema = z.object({ url: z.url() });
export type OauthConnectStart = z.infer<typeof oauthConnectStartSchema>;

/** One provider account that signs in as the caller, and the address it had when linked. */
export const oauthIdentitySchema = z.object({
  provider: oauthProviderSchema,
  email: z.string(),
  connectedAt: z.iso.datetime(),
  /** The last sign-in through it; null until one happens (M18-07). */
  lastUsedAt: z.iso.datetime().nullable(),
});
export type OauthIdentity = z.infer<typeof oauthIdentitySchema>;

export const oauthIdentityListSchema = z.object({
  identities: z.array(oauthIdentitySchema),
  /** Whether the caller has a password, so the security page can say which provider is their last way in. */
  passwordSet: z.boolean(),
});
export type OauthIdentityList = z.infer<typeof oauthIdentityListSchema>;

/**
 * Whether disconnecting `provider` would leave the account with no way to
 * sign in: no password and no other provider account (1.0.2). The api refuses
 * that disconnect with `oauth-last-sign-in`, and the security page disables
 * its button, from this one rule.
 */
export const isLastSignInMethod = (list: OauthIdentityList, provider: OauthProvider): boolean =>
  !list.passwordSet && list.identities.length === 1 && list.identities[0]?.provider === provider;

/**
 * Which ways in this install offers, so the sign-in screen hides a provider
 * button rather than showing one that answers "not configured". It is public:
 * the answer is the same for everybody and is needed before anyone signs in.
 */
export const authMethodsSchema = z.object({
  sso: z.array(z.object({ id: z.uuid(), name: z.string().min(1).max(80) })).default([]),
  ssoEnforced: z.boolean().default(false),
  password: z.boolean(),
  magicLink: z.boolean(),
  oauth: z.record(oauthProviderSchema, z.boolean()),
  /**
   * M18-01. Whether the screen offers passkeys: `APP_URL` is https (or
   * `http://localhost`), passkeys are not paused, and SSO is not enforced.
   */
  passkey: z.boolean().default(false),
  /**
   * M18-01. `APP_URL`'s host is not the one this install's passkeys were made
   * for, so they are paused; the screen says so where the button would be.
   */
  passkeysPaused: z.boolean().default(false),
});
export type AuthMethods = z.infer<typeof authMethodsSchema>;

/**
 * What the confirm screen shows about a live sign-in link before anything is
 * spent: whose account it opens, and how long such a link lasts. Only a live
 * token gets an answer, and the token was emailed to that address, so the
 * answer tells its holder nothing they could not read in the inbox.
 */
export const magicLinkPreviewSchema = z.object({
  email: z.email(),
  /** The install's `auth.magicLinkTtlMinutes`, for the caption under the button. */
  expiresInMinutes: z.int().positive(),
});
export type MagicLinkPreview = z.infer<typeof magicLinkPreviewSchema>;

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
 * The ways an account can answer a second-factor challenge (M18-03). An
 * authenticator app and recovery codes are one entry, `totp`, because the
 * recovery link is always offered; `passkey` is true when the account holds a
 * passkey this install can use now. Older redirects carry neither, which reads
 * as an authenticator app alone.
 */
export const secondFactorOptionsSchema = z.object({ totp: z.boolean(), passkey: z.boolean() });
export type SecondFactorOptions = z.infer<typeof secondFactorOptionsSchema>;

const secondFactorChallengeSchema = z.object({
  kind: z.literal('totp-required'),
  challengeId: z.string().min(1),
  email: z.email(),
  factors: secondFactorOptionsSchema.default({ totp: true, passkey: false }),
});

/**
 * `totp-enrolment-required` was renamed `second-factor-enrolment-required` when
 * a passkey became a way to enrol (M18-03). Both are read as the new one; the
 * api sends the old one for one release ({@link toWireSignInResponse}).
 */
function aliasEnrolmentKind(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'totp-enrolment-required'
  ) {
    return { ...value, kind: 'second-factor-enrolment-required' };
  }
  return value;
}

/**
 * `POST /api/auth/sign-in` on the wire. Either the session, the id of a
 * second-factor challenge to answer at `POST /api/auth/totp`, or — when the
 * install requires 2FA and this account has none — the enrolment that has to
 * happen first (M0-06 builds that screen).
 */
export const signInResponseSchema = z.preprocess(
  aliasEnrolmentKind,
  z.discriminatedUnion('kind', [
    authSessionResponseSchema.extend({ kind: z.literal('session') }),
    secondFactorChallengeSchema,
    z.object({
      kind: z.literal('second-factor-enrolment-required'),
      challengeId: z.string().min(1),
    }),
  ]),
);
export type SignInResponse = z.infer<typeof signInResponseSchema>;

/** What the api still sends for the enrolment challenge: an admin bundle cached from before M18-03 only knows this name. */
export const LEGACY_ENROLMENT_KIND = 'totp-enrolment-required';

export type WireSignInResponse =
  | Exclude<SignInResponse, { kind: 'second-factor-enrolment-required' }>
  | { readonly kind: typeof LEGACY_ENROLMENT_KIND; readonly challengeId: string };

/**
 * The answer as it goes out. For one release the enrolment challenge keeps its
 * old name on the wire, so a browser still running an older admin bundle works;
 * every reader here accepts both. The new name is sent from the release after,
 * when the cached bundles have gone.
 */
export const toWireSignInResponse = (response: SignInResponse): WireSignInResponse =>
  response.kind === 'second-factor-enrolment-required'
    ? { kind: LEGACY_ENROLMENT_KIND, challengeId: response.challengeId }
    : response;

/**
 * The same three outcomes as the admin's `AuthApi` reports them. The access
 * token is missing on purpose: `HttpAuthApi` keeps it in memory and no screen
 * ever holds one, so no screen can put it somewhere that persists.
 */
export const signInResultSchema = z.preprocess(
  aliasEnrolmentKind,
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session'), session: sessionSchema }),
    secondFactorChallengeSchema,
    z.object({
      kind: z.literal('second-factor-enrolment-required'),
      challengeId: z.string().min(1),
    }),
  ]),
);
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

/** A completed enrolment challenge: the codes, once, and the session it was standing in for. */
export const enrolmentCompleteResponseSchema = authSessionResponseSchema.extend(
  recoveryCodesSchema.shape,
);
export type EnrolmentCompleteResponse = z.infer<typeof enrolmentCompleteResponseSchema>;

/**
 * Every failure the screens have to tell apart. The api returns the code; the
 * screen picks the catalog key, so no user-facing English crosses this boundary
 * (packages/i18n README).
 */
const authErrorCodes = [
  'sso-email-unverified',
  'sso-no-access',
  'sso-connection-disabled',
  'sso-required',
  'sso-invalid-response',
  /** The matched account already has an identity on this or another SSO connection. */
  'sso-identity-conflict',
  /**
   * The provider does not control this address (GitHub always; Google on a
   * non-Workspace, non-Gmail address), so it cannot make the first link: the
   * person signs in another way and connects the account from the security page.
   */
  'oauth-link-required',
  /** The provider account is linked to another person, or this person already has one of that provider. */
  'oauth-identity-conflict',
  /** Disconnecting this provider account would leave no password and no other provider (1.0.2). */
  'oauth-last-sign-in',
  /** A Google account outside `oauth.google.allowedDomains` (M18-07). Says nothing about accounts. */
  'oauth-domain-not-allowed',
  /** A Microsoft account outside the one tenant this install trusts (M18-08). Says nothing about accounts. */
  'oauth-tenant-mismatch',
  /** An invitation accepted with a provider after the invitation was spent or withdrawn (M18-07). */
  'invite-expired',
  'rate-limited',
  'invalid-credentials',
  'totp-mismatch',
  'totp-locked',
  'challenge-expired',
  'recovery-invalid',
  'no-account',
  'unavailable',
  /** A new password that is on the bundled list of breached passwords (ASVS 2.1.7). */
  'password-breached',
  /** `APP_URL` is plain http on a host other than localhost, or an IP address: browsers refuse WebAuthn there (M18-01). */
  'passkeys-unavailable',
  /** `APP_URL`'s host is no longer the RP ID the install's passkeys were made for; they are paused (M18-01). */
  'passkeys-rp-changed',
  /** Removing this passkey would leave an account that must have a second factor with none (M18-02). */
  'second-factor-required',
  /** The account already holds the most passkeys it may (M18-02). */
  'passkey-limit',
  /** This authenticator is already registered for the account (M18-02). */
  'passkey-duplicate',
  /** An authenticator app is already on; staging a new secret would replace it with no proof (M18-03). */
  'totp-already-enabled',
  /** There is no authenticator app to replace; the account goes through enrolment instead (#373). */
  'totp-not-enabled',
  /** Under SSO enforcement a break-glass account may not prove a step-up with a recovery code (ADR 0053, #373). */
  'recovery-code-not-allowed',
  /** A passkey assertion that did not verify, as a second factor or when enrolling (M18-03). Carries `attemptsLeft`. */
  'passkey-invalid',
] as const;
export const authErrorCodeSchema = z.enum(authErrorCodes);
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

export const authErrorSchema = z.object({
  code: authErrorCodeSchema,
  /** Present on `totp-mismatch`, `recovery-invalid` and `passkey-invalid`: how many tries are left before the lock. */
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

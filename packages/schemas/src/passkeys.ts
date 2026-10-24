import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, recoveryCodesSchema } from './auth.js';

/**
 * Staff passkeys on `/api/me/passkeys` (M18-02, ADR 0050): the wire shapes of
 * the list, the step-up and the registration ceremony.
 *
 * The WebAuthn JSON shapes are checked here, at the boundary, before
 * `@simplewebauthn/server` sees them: every field the library reads is a
 * bounded base64url string, and anything else a browser adds is dropped.
 */

/** Passkeys one account may hold (ADR 0050). */
export const MAX_PASSKEYS_PER_ACCOUNT = 10;

/** The most a name may hold: the artboard's "Up to 64 characters". */
export const PASSKEY_NAME_MAX_LENGTH = 64;

const base64Url = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(/^[A-Za-z0-9_-]+$/);

/** The longest credential id the specification allows is 1,023 bytes. */
const CREDENTIAL_ID = base64Url(1400);

const CEREMONY_ID = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const CLIENT_DATA = base64Url(4096);

/** What `navigator.credentials.create()` returns, as `@simplewebauthn/browser` serialises it. */
export const registrationResponseSchema = z.object({
  id: CREDENTIAL_ID,
  rawId: CREDENTIAL_ID,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: CLIENT_DATA,
    attestationObject: base64Url(16_384),
    authenticatorData: base64Url(8192).optional(),
    transports: z.array(z.string().max(32)).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64Url(2048).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.object({
    credProps: z.object({ rk: z.boolean().optional() }).optional(),
  }),
});
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

/** What `navigator.credentials.get()` returns, as `@simplewebauthn/browser` serialises it. */
export const authenticationResponseSchema = z.object({
  id: CREDENTIAL_ID,
  rawId: CREDENTIAL_ID,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: CLIENT_DATA,
    authenticatorData: base64Url(8192),
    signature: base64Url(2048),
    userHandle: base64Url(256).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.object({}),
});
export type AuthenticationResponse = z.infer<typeof authenticationResponseSchema>;

/**
 * "Confirm it's you" before a passkey is added, renamed or removed: the
 * current password, a live authenticator code, or an assertion from a passkey
 * the account already holds. Exactly one. A session proves somebody signed in,
 * not who is at the keyboard now (ASVS 3.7.1).
 */
export const passkeyProofSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    passkey: z
      .object({ ceremonyId: CEREMONY_ID, response: authenticationResponseSchema })
      .optional(),
  })
  .refine(
    (value) =>
      [value.currentPassword, value.code, value.passkey].filter((part) => part !== undefined)
        .length === 1,
    'Send the current password, an authentication code or a passkey assertion, and only one',
  );
export type PasskeyProof = z.infer<typeof passkeyProofSchema>;

/** A name as the person typed it: trimmed, 1 to 64 characters, no control characters. */
export const passkeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PASSKEY_NAME_MAX_LENGTH)
  // Control characters, bidi overrides and isolates, and zero-width characters: a name is shown inside
  // sentences and emails, where any of them could reorder or hide what the person reads.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  .regex(/^[^\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]+$/);

export const passkeyBeginRequestSchema = z.object({ proof: passkeyProofSchema });
export type PasskeyBeginRequest = z.infer<typeof passkeyBeginRequestSchema>;

export const passkeyFinishRequestSchema = z.object({
  ceremonyId: CEREMONY_ID,
  response: registrationResponseSchema,
  name: passkeyNameSchema,
});
export type PasskeyFinishRequest = z.infer<typeof passkeyFinishRequestSchema>;

export const passkeyRenameRequestSchema = z.object({
  name: passkeyNameSchema,
  proof: passkeyProofSchema,
});
export type PasskeyRenameRequest = z.infer<typeof passkeyRenameRequestSchema>;

export const passkeyRemoveRequestSchema = z.object({ proof: passkeyProofSchema });
export type PasskeyRemoveRequest = z.infer<typeof passkeyRemoveRequestSchema>;

/** The browser's options, passed through to `startRegistration` / `startAuthentication` as the library made them. */
const optionsJson = z.record(z.string(), z.unknown());

export const passkeyRegistrationOptionsSchema = z.object({
  ceremonyId: CEREMONY_ID,
  options: optionsJson,
});
export type PasskeyRegistrationOptions = z.infer<typeof passkeyRegistrationOptionsSchema>;

export const passkeyStepUpOptionsSchema = z.object({
  ceremonyId: CEREMONY_ID,
  options: optionsJson,
});
export type PasskeyStepUpOptions = z.infer<typeof passkeyStepUpOptionsSchema>;

export const passkeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  /** When it last confirmed a change on this page; null until it does. Sign-in uses arrive with M18-03/04. */
  lastUsedAt: z.iso.datetime().nullable(),
  /** Backed up by its platform (the "Synced" chip). Display only. */
  synced: z.boolean(),
});
export type Passkey = z.infer<typeof passkeySchema>;

export const passkeyListSchema = z.object({
  passkeys: z.array(passkeySchema),
  limit: z.number().int().positive(),
  /**
   * `available`: the card works. `paused`: `APP_URL`'s host is no longer the
   * pinned RP ID. `unavailable`: `APP_URL` is not a secure context.
   */
  state: z.enum(['available', 'paused', 'unavailable']),
  /**
   * Removing the last passkey would leave an account that must have a second
   * factor with none (`second-factor-required`); the card disables Remove.
   */
  removalBlocked: z.boolean(),
  /** Whether an authenticator app is on, for what the remove dialog says still protects the account. */
  authenticatorApp: z.boolean(),
});
export type PasskeyList = z.infer<typeof passkeyListSchema>;

export const passkeyIdParamSchema = z.object({ id: z.uuid() });
export type PasskeyIdParam = z.infer<typeof passkeyIdParamSchema>;

/**
 * A passkey as the second factor of a sign-in (M18-03). The challenge id is the
 * credential for the options call, as it is for `/api/auth/totp`; the
 * ceremony id ties the assertion to the options the same challenge was handed.
 */
export const passkeySecondFactorOptionsRequestSchema = z.object({
  challengeId: z.string().min(1),
});
export type PasskeySecondFactorOptionsRequest = z.infer<
  typeof passkeySecondFactorOptionsRequestSchema
>;

export const passkeySecondFactorVerifyRequestSchema = z.object({
  challengeId: z.string().min(1),
  ceremonyId: CEREMONY_ID,
  response: authenticationResponseSchema,
  trustDevice: z.boolean(),
});
export type PasskeySecondFactorVerifyRequest = z.infer<
  typeof passkeySecondFactorVerifyRequestSchema
>;

/** The part of a second-factor answer the browser makes; the screen adds the challenge. */
export type PasskeySecondFactorAnswer = Pick<
  PasskeySecondFactorVerifyRequest,
  'ceremonyId' | 'response'
>;

/** Passwordless sign-in (M18-04): the assertion for the options the same page fetched. */
export const passkeySignInVerifyRequestSchema = z.object({
  ceremonyId: CEREMONY_ID,
  response: authenticationResponseSchema,
});
export type PasskeySignInVerifyRequest = z.infer<typeof passkeySignInVerifyRequestSchema>;

/** Enrolling a passkey before there is a session: the enrolment challenge stands in for it. */
export const enrolmentPasskeyConfirmRequestSchema = z.object({
  challengeId: z.string().min(1),
  ceremonyId: CEREMONY_ID,
  response: registrationResponseSchema,
  name: passkeyNameSchema,
});
export type EnrolmentPasskeyConfirmRequest = z.infer<typeof enrolmentPasskeyConfirmRequestSchema>;
export type PasskeyEnrolmentRequest = Omit<EnrolmentPasskeyConfirmRequest, 'challengeId'>;

/**
 * A passkey that has just been added. `recoveryCodes` is present only when it
 * is the account's first second factor of either kind: the codes are drawn with
 * it and shown once (DOMAIN-RULES §12.1).
 */
export const passkeyAddedSchema = passkeySchema.extend({
  recoveryCodes: recoveryCodesSchema.shape.recoveryCodes.optional(),
});
export type PasskeyAdded = z.infer<typeof passkeyAddedSchema>;

/** Redrawing the recovery codes with a passkey, from the step-up ceremony this session began. */
export const passkeyRecoveryRedrawRequestSchema = z.object({
  passkey: z.object({ ceremonyId: CEREMONY_ID, response: authenticationResponseSchema }),
});
export type PasskeyRecoveryRedrawRequest = z.infer<typeof passkeyRecoveryRedrawRequestSchema>;

/**
 * Passkeys as the install admin sees them on Settings › Authentication
 * (M18-06): whether they work, the RP ID they were made for, and how many
 * there are. Counts only: whose passkeys they are stays with their holders.
 */
export const installPasskeysSchema = z.strictObject({
  state: z.enum(['available', 'paused', 'unavailable']),
  /** The host `APP_URL` implies; null when passkeys cannot run there. */
  rpId: z.string().nullable(),
  /** The RP ID the passkeys were made for; null before the first one. */
  pinnedRpId: z.string().nullable(),
  /** When the first registration pinned it; null when unpinned or set by the environment. */
  pinnedAt: z.string().datetime().nullable(),
  /** `HD_AUTH_WEBAUTHN_RP_ID` pins it, so it cannot be moved from here. */
  pinLocked: z.boolean(),
  passkeyCount: z.number().int().nonnegative(),
  holderCount: z.number().int().nonnegative(),
  /**
   * What moving the passkeys would break, counted while paused (zero otherwise).
   * Any non-zero count makes the move refuse (`move-blocked`).
   */
  blockers: z.strictObject({
    /** Configured SSO break-glass accounts that rely on a verified passkey. */
    breakGlassAccounts: z.number().int().nonnegative(),
    /** Accounts that must have a second factor and have only passkeys. */
    secondFactorAccounts: z.number().int().nonnegative(),
  }),
});
export type InstallPasskeys = z.infer<typeof installPasskeysSchema>;

/** What moving the passkeys to the new address removed. */
export const installPasskeysMovedSchema = z.strictObject({
  rpId: z.string(),
  passkeysRemoved: z.number().int().nonnegative(),
  holdersNotified: z.number().int().nonnegative(),
});
export type InstallPasskeysMoved = z.infer<typeof installPasskeysMovedSchema>;

/**
 * Why moving the passkeys was refused, on `error.passkeys.reason`: nothing is
 * paused, the environment pins the RP ID, or the move would lock accounts out
 * (the counts are on `GET /api/install/passkeys`).
 */
export const passkeysRefusalSchema = z.enum(['not-paused', 'pin-locked', 'move-blocked']);
export type PasskeysRefusal = z.infer<typeof passkeysRefusalSchema>;

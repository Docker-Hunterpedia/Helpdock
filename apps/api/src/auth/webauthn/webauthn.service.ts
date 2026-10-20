import { randomBytes } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { AuthFailure } from '../auth-failure.js';
import {
  WEBAUTHN_CEREMONY_TTL_SECONDS,
  type WebAuthnCeremony,
  type WebAuthnCeremonyBinding,
  type WebAuthnCeremonyPurpose,
  type WebAuthnCeremonyStore,
} from './ceremony-store.js';
import { RELYING_PARTY_NAME, type RelyingParty, relyingPartyFor } from './relying-party.js';
import type { PinnedRpId, RpIdPin } from './rp-id-pin.js';

/**
 * A thin layer over `@simplewebauthn/server` (M18-01, ADR 0050) that fixes
 * every parameter this install has an opinion on, so the routes built on it
 * (M18-02 to M18-05) cannot get one wrong:
 *
 * - the RP ID and the one expected origin come from `APP_URL`, and the RP ID
 *   is pinned at the first ceremony (`rp-id-pin.ts`);
 * - EdDSA, ES256 and RS256 only, which keeps the library's post-quantum path
 *   closed;
 * - attestation `none`: no attestation statement is asked for or parsed;
 * - user verification by purpose ({@link USER_VERIFICATION});
 * - one ceremony per challenge, spent before it is checked.
 *
 * It holds no credentials: callers look them up and store them, so the
 * service has no opinion on which routes may reach whose passkeys.
 */

/** COSE algorithm ids: EdDSA, ES256, RS256 (ASVS 2.9.3). */
export const SUPPORTED_ALGORITHM_IDS: readonly number[] = [-8, -7, -257];

/**
 * Authenticators keep about 64 bytes of a name, which is some 30 Arabic
 * letters; the api cuts on a code-point boundary rather than leave the
 * authenticator to cut a letter in half.
 */
export const USER_NAME_MAX_BYTES = 64;

/** The specification's limit on a credential id. */
const CREDENTIAL_ID_MAX_BYTES = 1023;

const CHALLENGE_BYTES = 32;

/**
 * Where a passkey is the whole sign-in, or the factor that lets an install
 * admin past SSO enforcement, user verification (a PIN or a biometric) is
 * required: that is what makes one assertion two factors. Where it follows
 * another factor, user presence is enough, so a security key without a PIN
 * still works as a second factor.
 */
export const USER_VERIFICATION: Readonly<
  Record<WebAuthnCeremonyPurpose, 'required' | 'preferred'>
> = {
  register: 'preferred',
  'second-factor': 'preferred',
  'step-up': 'preferred',
  passwordless: 'required',
  'break-glass': 'required',
};

/** The transports WebAuthn Level 3 names; anything else a browser reports is dropped. */
const TRANSPORTS: ReadonlySet<string> = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

const NO_AAGUID = '00000000-0000-0000-0000-000000000000';

/**
 * - `available`: ceremonies run.
 * - `paused`: `APP_URL`'s host is no longer the pinned RP ID, so no passkey
 *   this install holds can sign; ceremonies answer `passkeys-rp-changed`.
 * - `unavailable`: `APP_URL` is not a secure context, or is an IP address.
 */
export type PasskeyStatus =
  | { readonly state: 'available'; readonly rpId: string; readonly pinned: PinnedRpId | null }
  | { readonly state: 'paused'; readonly rpId: string; readonly pinned: PinnedRpId }
  | { readonly state: 'unavailable' };

/** A credential as the routes hand it over, for `excludeCredentials` and `allowCredentials`. */
export interface PasskeyDescriptor {
  readonly credentialId: Uint8Array;
  readonly transports: readonly string[];
}

/** A stored credential, as the verification needs it. */
export interface StoredPasskey extends PasskeyDescriptor {
  readonly userId: string;
  readonly publicKey: Uint8Array;
  readonly signCount: number;
}

/** What a verified registration gives the caller to store. */
export interface RegisteredPasskey {
  readonly credentialId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly algorithm: number;
  readonly signCount: number;
  readonly transports: string[];
  readonly aaguid: string | null;
  readonly discoverable: boolean | null;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly userVerified: boolean;
}

/**
 * Why an assertion was refused. Callers answer `invalid-credentials` for all
 * of them (DOMAIN-RULES: no enumeration) and keep the reason for the audit
 * trail.
 */
export type AssertionRefusal =
  | 'unknown-credential'
  | 'wrong-user'
  | 'bad-assertion'
  | 'counter-regressed';

export type AssertionCheck =
  | {
      readonly ok: true;
      readonly credential: StoredPasskey;
      readonly newSignCount: number;
      readonly userVerified: boolean;
      readonly backedUp: boolean;
    }
  | { readonly ok: false; readonly reason: AssertionRefusal; readonly userId: string | null };

export interface CeremonyOptions<TOptions> {
  /** Handed to the browser with the options, and posted back with its answer. */
  readonly ceremonyId: string;
  readonly options: TOptions;
}

/** Cuts a string to at most `maxBytes` of UTF-8 without splitting a code point. */
export const truncateUtf8 = (value: string, maxBytes: number): string => {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > maxBytes) {
      break;
    }
    end += character.length;
  }
  return value.slice(0, end);
};

/**
 * The counter rule (ADR 0050). Synced passkeys report 0 forever, so a counter
 * is compared only once either side has moved; after that it must grow.
 */
export const counterRegressed = (stored: number, presented: number): boolean =>
  (stored > 0 || presented > 0) && presented <= stored;

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const descriptorsOf = (credentials: readonly PasskeyDescriptor[]) =>
  credentials.map((credential) => ({
    id: toBase64Url(credential.credentialId),
    transports: credential.transports.filter((transport) => TRANSPORTS.has(transport)),
  }));

export class WebAuthnService {
  readonly #appUrl: string;
  readonly #ceremonies: WebAuthnCeremonyStore;
  readonly #pin: RpIdPin;

  constructor(options: {
    readonly appUrl: string;
    readonly ceremonies: WebAuthnCeremonyStore;
    readonly pin: RpIdPin;
  }) {
    this.#appUrl = options.appUrl;
    this.#ceremonies = options.ceremonies;
    this.#pin = options.pin;
  }

  async status(): Promise<PasskeyStatus> {
    const relyingParty = relyingPartyFor(this.#appUrl);
    if (relyingParty === null) {
      return { state: 'unavailable' };
    }
    const pinned = await this.#pin.read();
    if (pinned !== null && pinned.rpId !== relyingParty.id) {
      return { state: 'paused', rpId: relyingParty.id, pinned };
    }
    return { state: 'available', rpId: relyingParty.id, pinned };
  }

  /**
   * Options for adding a passkey to an account that is already signed in.
   * The handle is the account's 32-byte `webauthn_user_handle`, never its id.
   */
  async registrationOptions(input: {
    readonly user: { readonly handle: Uint8Array; readonly email: string; readonly name: string };
    readonly existing: readonly PasskeyDescriptor[];
    readonly binding: Required<WebAuthnCeremonyBinding>;
  }): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    const relyingParty = await this.#beginningRelyingParty();

    const options = await generateRegistrationOptions({
      rpName: RELYING_PARTY_NAME,
      rpID: relyingParty.id,
      userID: new Uint8Array(input.user.handle),
      userName: truncateUtf8(input.user.email, USER_NAME_MAX_BYTES),
      userDisplayName: truncateUtf8(input.user.name, USER_NAME_MAX_BYTES),
      // Bytes, not a string: the library would encode a string's UTF-8 as the challenge.
      challenge: new Uint8Array(randomBytes(CHALLENGE_BYTES)),
      timeout: WEBAUTHN_CEREMONY_TTL_SECONDS * 1000,
      attestationType: 'none',
      excludeCredentials: descriptorsOf(input.existing),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: USER_VERIFICATION.register,
      },
      extensions: { credProps: true },
      supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
    });

    const ceremonyId = await this.#ceremonies.begin({
      purpose: 'register',
      challenge: options.challenge,
      rpId: relyingParty.id,
      ...input.binding,
    });
    return { ceremonyId, options };
  }

  /**
   * Checks a new credential. Throws `challenge-expired` for a ceremony that is
   * gone or not this caller's, and `invalid-credentials` for an answer that
   * does not verify.
   */
  async verifyRegistration(input: {
    readonly ceremonyId: string;
    readonly binding: Required<WebAuthnCeremonyBinding>;
    readonly response: RegistrationResponseJSON;
  }): Promise<RegisteredPasskey> {
    const ceremony = await this.#spend(input.ceremonyId, 'register', input.binding);
    const relyingParty = await this.#currentRelyingParty(ceremony);

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: relyingParty.origin,
        expectedRPID: relyingParty.id,
        requireUserVerification: false,
        supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
      });
    } catch {
      throw new AuthFailure('invalid-credentials');
    }
    if (!verification.verified) {
      throw new AuthFailure('invalid-credentials');
    }

    const info = verification.registrationInfo;
    const credentialId = Buffer.from(info.credential.id, 'base64url');
    const algorithm = decodeCredentialPublicKey(info.credential.publicKey).get(cose.COSEKEYS.alg);
    // No check on `fmt`: asking for `none` lets the browser strip the
    // statement, but some authenticators still send a `packed`
    // self-attestation, which the library verifies like any other.
    if (
      credentialId.length === 0 ||
      credentialId.length > CREDENTIAL_ID_MAX_BYTES ||
      algorithm === undefined ||
      !SUPPORTED_ALGORITHM_IDS.includes(algorithm)
    ) {
      throw new AuthFailure('invalid-credentials');
    }

    return {
      credentialId: new Uint8Array(credentialId),
      publicKey: info.credential.publicKey,
      algorithm,
      signCount: info.credential.counter,
      transports: (input.response.response.transports ?? []).filter((transport) =>
        TRANSPORTS.has(transport),
      ),
      aaguid: info.aaguid === NO_AAGUID ? null : info.aaguid,
      discoverable: input.response.clientExtensionResults.credProps?.rk ?? null,
      backupEligible: info.credentialDeviceType === 'multiDevice',
      backedUp: info.credentialBackedUp,
      userVerified: info.userVerified,
    };
  }

  /**
   * Options for an assertion. `allow` lists the account's credentials once a
   * first factor has named the account; passwordless sign-in passes none, so
   * the options are the same for every caller and name nobody.
   */
  async authenticationOptions(input: {
    readonly purpose: Exclude<WebAuthnCeremonyPurpose, 'register'>;
    readonly binding?: WebAuthnCeremonyBinding;
    readonly allow?: readonly PasskeyDescriptor[];
  }): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    const relyingParty = await this.#beginningRelyingParty();

    const options = await generateAuthenticationOptions({
      rpID: relyingParty.id,
      // Bytes, not a string: the library would encode a string's UTF-8 as the challenge.
      challenge: new Uint8Array(randomBytes(CHALLENGE_BYTES)),
      timeout: WEBAUTHN_CEREMONY_TTL_SECONDS * 1000,
      userVerification: USER_VERIFICATION[input.purpose],
      ...(input.allow === undefined ? {} : { allowCredentials: descriptorsOf(input.allow) }),
    });

    const ceremonyId = await this.#ceremonies.begin({
      purpose: input.purpose,
      challenge: options.challenge,
      rpId: relyingParty.id,
      ...input.binding,
    });
    return { ceremonyId, options };
  }

  /**
   * Checks an assertion. The ceremony is spent first, so it is gone whatever
   * the answer; a ceremony that is gone throws `challenge-expired`. Every
   * other refusal is returned with its reason rather than thrown, so the
   * caller can audit it before answering `invalid-credentials`.
   */
  async verifyAuthentication(input: {
    readonly ceremonyId: string;
    readonly purpose: Exclude<WebAuthnCeremonyPurpose, 'register'>;
    readonly binding?: WebAuthnCeremonyBinding;
    readonly response: AuthenticationResponseJSON;
    readonly findCredential: (credentialId: Uint8Array) => Promise<StoredPasskey | undefined>;
  }): Promise<AssertionCheck> {
    const ceremony = await this.#spend(input.ceremonyId, input.purpose, input.binding ?? {});
    const relyingParty = await this.#currentRelyingParty(ceremony);

    const rawId = typeof input.response.rawId === 'string' ? input.response.rawId : '';
    const credentialId = Buffer.from(rawId, 'base64url');
    const credential =
      credentialId.length === 0 || credentialId.length > CREDENTIAL_ID_MAX_BYTES
        ? undefined
        : await input.findCredential(new Uint8Array(credentialId));
    if (credential === undefined) {
      return { ok: false, reason: 'unknown-credential', userId: null };
    }
    if (ceremony.userId !== undefined && credential.userId !== ceremony.userId) {
      return { ok: false, reason: 'wrong-user', userId: ceremony.userId };
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: relyingParty.origin,
        expectedRPID: relyingParty.id,
        credential: {
          id: toBase64Url(credential.credentialId),
          publicKey: new Uint8Array(credential.publicKey),
          // The counter rule is applied below, once the signature is known to
          // be good: a forged assertion must not be able to raise a
          // counter-regression alarm.
          counter: 0,
          transports: credential.transports.filter((transport) => TRANSPORTS.has(transport)),
        },
        requireUserVerification: USER_VERIFICATION[input.purpose] === 'required',
      });
    } catch {
      return { ok: false, reason: 'bad-assertion', userId: credential.userId };
    }
    if (!verification.verified) {
      return { ok: false, reason: 'bad-assertion', userId: credential.userId };
    }

    const { newCounter, userVerified, credentialBackedUp } = verification.authenticationInfo;
    if (counterRegressed(credential.signCount, newCounter)) {
      return { ok: false, reason: 'counter-regressed', userId: credential.userId };
    }

    return {
      ok: true,
      credential,
      newSignCount: newCounter,
      userVerified,
      backedUp: credentialBackedUp,
    };
  }

  /** The relying party for a new ceremony, pinning it if this is the first. */
  async #beginningRelyingParty(): Promise<RelyingParty> {
    const relyingParty = this.#secureRelyingParty();
    const pinned = (await this.#pin.read()) ?? (await this.#pin.pinIfUnset(relyingParty.id));
    if (pinned.rpId !== relyingParty.id) {
      throw new AuthFailure('passkeys-rp-changed');
    }
    return relyingParty;
  }

  /** The relying party for finishing a ceremony: the one it began under, still pinned. */
  async #currentRelyingParty(ceremony: WebAuthnCeremony): Promise<RelyingParty> {
    const relyingParty = this.#secureRelyingParty();
    const pinned = await this.#pin.read();
    if (pinned?.rpId !== relyingParty.id || ceremony.rpId !== relyingParty.id) {
      throw new AuthFailure('passkeys-rp-changed');
    }
    return relyingParty;
  }

  #secureRelyingParty(): RelyingParty {
    const relyingParty = relyingPartyFor(this.#appUrl);
    if (relyingParty === null) {
      throw new AuthFailure('passkeys-unavailable');
    }
    return relyingParty;
  }

  async #spend(
    ceremonyId: string,
    purpose: WebAuthnCeremonyPurpose,
    binding: WebAuthnCeremonyBinding,
  ): Promise<WebAuthnCeremony> {
    const ceremony = await this.#ceremonies.consume(ceremonyId, purpose, binding);
    if (ceremony === null) {
      throw new AuthFailure('challenge-expired');
    }
    return ceremony;
  }
}

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { DbTransaction } from '@helpdock/db';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  cose,
  decodeAttestationObject,
  decodeCredentialPublicKey,
  isoCBOR,
} from '@simplewebauthn/server/helpers';
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
 *   is pinned by the first successful registration (`rp-id-pin.ts`);
 * - EdDSA, ES256 and RS256 only, which keeps the library's post-quantum path
 *   closed;
 * - attestation `none`: a statement that names a certificate chain is refused
 *   before the library sees it ({@link attestationIsAccepted});
 * - no cross-origin answers: the admin is never framed;
 * - user verification by purpose ({@link USER_VERIFICATION});
 * - a person bound to every ceremony except passwordless sign-in;
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
 * - `unavailable`: `APP_URL` is not a secure context, or not a domain.
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

/** The person (and, where there is one, the browser session) a ceremony belongs to. */
export interface PersonBinding {
  readonly userId: string;
  readonly familyId?: string;
}

/**
 * Which assertion is asked for, and for whom. Passwordless sign-in is the one
 * purpose with nobody named yet; every other one follows a first factor or
 * runs inside a session, so it names the person, and only that person's
 * passkey can answer it. Without the binding, anyone's passkey would do.
 */
export type AssertionPurpose =
  | { readonly purpose: 'passwordless'; readonly binding?: undefined }
  | {
      readonly purpose: Exclude<WebAuthnCeremonyPurpose, 'register' | 'passwordless'>;
      readonly binding: PersonBinding;
    };

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

/**
 * Whether an attestation statement is one this install takes: `none`, or a
 * `packed` self-attestation, which some authenticators send whatever was
 * asked for and which is checked against the credential's own key. Anything
 * that names a certificate chain is refused here, before the library could
 * follow the chain's revocation lists over the network.
 */
export const attestationIsAccepted = (attestationObject: string): boolean => {
  try {
    const decoded = decodeAttestationObject(Buffer.from(attestationObject, 'base64url'));
    const format = decoded.get('fmt');
    return (
      format === 'none' || (format === 'packed' && decoded.get('attStmt').get('x5c') === undefined)
    );
  } catch {
    return false;
  }
};

/**
 * False for client data that says it came from inside a frame, or that cannot
 * be read. The admin is never framed, and the library lets a cross-origin
 * answer through when the browser omits `topOrigin`.
 */
export const clientDataIsSameOrigin = (clientDataJSON: string): boolean => {
  try {
    const clientData: unknown = JSON.parse(
      Buffer.from(clientDataJSON, 'base64url').toString('utf8'),
    );
    return (
      typeof clientData === 'object' &&
      clientData !== null &&
      (clientData as { crossOrigin?: unknown }).crossOrigin !== true
    );
  } catch {
    return false;
  }
};

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const descriptorsOf = (credentials: readonly PasskeyDescriptor[]) =>
  credentials.map((credential) => ({
    id: toBase64Url(credential.credentialId),
    transports: credential.transports.filter((transport) => TRANSPORTS.has(transport)),
  }));

type RegistrationInfo = Extract<
  VerifiedRegistrationResponse,
  { verified: true }
>['registrationInfo'];

/** The library's verdict on a new credential, or null when it refuses (it throws to refuse). */
const verifyAttestation = async (
  response: RegistrationResponseJSON,
  ceremony: WebAuthnCeremony,
  relyingParty: RelyingParty,
): Promise<RegistrationInfo | null> => {
  if (
    !attestationIsAccepted(response.response.attestationObject) ||
    !clientDataIsSameOrigin(response.response.clientDataJSON)
  ) {
    return null;
  }
  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.id,
      requireUserVerification: false,
      supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
    });
    return verification.verified ? verification.registrationInfo : null;
  } catch {
    return null;
  }
};

/** What is stored for a verified credential, or null for one this install will not hold. */
const toRegisteredPasskey = (
  info: RegistrationInfo,
  response: RegistrationResponseJSON,
): RegisteredPasskey | null => {
  const credentialId = Buffer.from(info.credential.id, 'base64url');
  const algorithm = decodeCredentialPublicKey(info.credential.publicKey).get(cose.COSEKEYS.alg);
  if (
    credentialId.length === 0 ||
    credentialId.length > CREDENTIAL_ID_MAX_BYTES ||
    algorithm === undefined ||
    !SUPPORTED_ALGORITHM_IDS.includes(algorithm)
  ) {
    return null;
  }

  return {
    credentialId: new Uint8Array(credentialId),
    publicKey: info.credential.publicKey,
    algorithm,
    signCount: info.credential.counter,
    transports: (response.response.transports ?? []).filter((transport) =>
      TRANSPORTS.has(transport),
    ),
    aaguid: info.aaguid === NO_AAGUID ? null : info.aaguid,
    discoverable: response.clientExtensionResults.credProps?.rk ?? null,
    backupEligible: info.credentialDeviceType === 'multiDevice',
    backedUp: info.credentialBackedUp,
    userVerified: info.userVerified,
  };
};

/** The stored credential an assertion names, or undefined for an id no credential can have. */
const lookUpCredential = async (
  rawId: string,
  findCredential: (credentialId: Uint8Array) => Promise<StoredPasskey | undefined>,
): Promise<StoredPasskey | undefined> => {
  const credentialId = Buffer.from(rawId, 'base64url');
  if (credentialId.length === 0 || credentialId.length > CREDENTIAL_ID_MAX_BYTES) {
    return undefined;
  }
  return findCredential(new Uint8Array(credentialId));
};

/**
 * The library's verdict on the challenge, origin, RP ID, flags and signature,
 * or null when it refuses. The library reports every refusal, malformed
 * input included, by throwing; on an unauthenticated endpoint each one gets
 * the same answer, so the error carries nothing the caller could use.
 */
const verifySignature = async (input: {
  readonly response: AuthenticationResponseJSON;
  readonly ceremony: WebAuthnCeremony;
  readonly relyingParty: RelyingParty;
  readonly credential: StoredPasskey;
  readonly requireUserVerification: boolean;
}): Promise<VerifiedAuthenticationResponse['authenticationInfo'] | null> => {
  if (!clientDataIsSameOrigin(input.response.response.clientDataJSON)) {
    return null;
  }
  try {
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.ceremony.challenge,
      expectedOrigin: input.relyingParty.origin,
      expectedRPID: input.relyingParty.id,
      credential: {
        id: toBase64Url(input.credential.credentialId),
        publicKey: new Uint8Array(input.credential.publicKey),
        // The counter rule is the caller's, applied after this check.
        counter: 0,
        transports: input.credential.transports.filter((transport) => TRANSPORTS.has(transport)),
      },
      requireUserVerification: input.requireUserVerification,
    });
    return verification.verified ? verification.authenticationInfo : null;
  } catch {
    return null;
  }
};

let standIn: StoredPasskey | undefined;

/**
 * A credential nobody holds, with a real key. An assertion that names no stored
 * credential is checked against it and the verdict thrown away, so an unknown
 * credential costs the signature check a known one does and the sign-in
 * endpoint is not a stopwatch for which credential ids exist.
 */
const standInCredential = (): StoredPasskey => {
  if (standIn === undefined) {
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      format: 'jwk',
    });
    standIn = {
      userId: '',
      credentialId: new Uint8Array(32),
      publicKey: isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [cose.COSEKEYS.kty, 2],
          [cose.COSEKEYS.alg, -7],
          [cose.COSEKEYS.crv, 1],
          [cose.COSEKEYS.x, Buffer.from(jwk.x ?? '', 'base64url')],
          [cose.COSEKEYS.y, Buffer.from(jwk.y ?? '', 'base64url')],
        ]),
      ),
      signCount: 0,
      transports: [],
    };
  }
  return standIn;
};

/**
 * The types already demand a person for every purpose but passwordless; this
 * holds the line for a caller that reaches the service around them.
 */
const requirePerson = <T extends PersonBinding>(
  purpose: WebAuthnCeremonyPurpose,
  binding: T | undefined,
): T => {
  if (binding?.userId === undefined || binding.userId === '') {
    throw new TypeError(`A ${purpose} passkey ceremony must name the person it is for`);
  }
  return binding;
};

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

  /** True when `HD_AUTH_WEBAUTHN_RP_ID` pins the RP ID, so it cannot be moved. */
  isPinLocked(): boolean {
    return this.#pin.isLocked();
  }

  /**
   * Moves the pin from `from` to `to` in one transaction with `within` (M18-06,
   * "Move passkeys"). Throws `RpIdPinChangedError` when the pin is no longer `from`.
   */
  moveRpId<T>(
    move: { readonly from: string; readonly to: string; readonly actorId: string },
    within: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#pin.moveTo(move, within);
  }

  /**
   * Options for adding a passkey to an account that is already signed in.
   * The handle is the account's 32-byte `webauthn_user_handle`, never its id.
   */
  async registrationOptions(input: {
    readonly user: { readonly handle: Uint8Array; readonly email: string; readonly name: string };
    readonly existing: readonly PasskeyDescriptor[];
    readonly binding: Required<PersonBinding>;
  }): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    const relyingParty = await this.#relyingParty();

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
      ...requirePerson('register', input.binding),
    });
    return { ceremonyId, options };
  }

  /**
   * Checks a new credential and, if it is the install's first, pins the RP ID
   * it was made for. Throws `challenge-expired` for a ceremony that is gone or
   * not this caller's, `invalid-credentials` for an answer that does not
   * verify, and `passkeys-rp-changed` when another host was pinned meanwhile.
   */
  async verifyRegistration(input: {
    readonly ceremonyId: string;
    readonly binding: Required<PersonBinding>;
    readonly response: RegistrationResponseJSON;
  }): Promise<RegisteredPasskey> {
    const ceremony = await this.#spend(input.ceremonyId, 'register', input.binding);
    const relyingParty = await this.#relyingPartyOf(ceremony);

    const info = await verifyAttestation(input.response, ceremony, relyingParty);
    const registered = info === null ? null : toRegisteredPasskey(info, input.response);
    if (registered === null) {
      throw new AuthFailure('invalid-credentials');
    }

    const pinned = await this.#pin.pinIfUnset(relyingParty.id);
    if (pinned.rpId !== relyingParty.id) {
      throw new AuthFailure('passkeys-rp-changed');
    }
    return registered;
  }

  /**
   * Options for an assertion. `allow` lists the account's credentials once a
   * first factor has named the account; passwordless sign-in passes none, so
   * the options are the same for every caller and name nobody.
   */
  async authenticationOptions(
    input: AssertionPurpose & { readonly allow?: readonly PasskeyDescriptor[] },
  ): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    const binding =
      input.purpose === 'passwordless' ? {} : requirePerson(input.purpose, input.binding);
    const relyingParty = await this.#relyingParty();

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
      ...binding,
    });
    return { ceremonyId, options };
  }

  /**
   * Checks an assertion. The ceremony is spent first, so it is gone whatever
   * the answer; a ceremony that is gone throws `challenge-expired`. Every
   * other refusal is returned with its reason rather than thrown, so the
   * caller can audit it before answering `invalid-credentials`.
   */
  async verifyAuthentication(
    input: AssertionPurpose & {
      readonly ceremonyId: string;
      readonly response: AuthenticationResponseJSON;
      readonly findCredential: (credentialId: Uint8Array) => Promise<StoredPasskey | undefined>;
    },
  ): Promise<AssertionCheck> {
    const ceremony = await this.#spend(input.ceremonyId, input.purpose, input.binding ?? {});
    const relyingParty = await this.#relyingPartyOf(ceremony);
    // A bound purpose names its person; a ceremony that somehow names nobody
    // would let any passkey answer it.
    if (input.purpose !== 'passwordless' && ceremony.userId === undefined) {
      return { ok: false, reason: 'wrong-user', userId: null };
    }

    const credential = await lookUpCredential(input.response.rawId, input.findCredential);
    if (credential === undefined) {
      await verifySignature({
        response: input.response,
        ceremony,
        relyingParty,
        credential: standInCredential(),
        requireUserVerification: USER_VERIFICATION[input.purpose] === 'required',
      });
      return { ok: false, reason: 'unknown-credential', userId: null };
    }
    if (ceremony.userId !== undefined && credential.userId !== ceremony.userId) {
      return { ok: false, reason: 'wrong-user', userId: ceremony.userId };
    }

    const signed = await verifySignature({
      response: input.response,
      ceremony,
      relyingParty,
      credential,
      requireUserVerification: USER_VERIFICATION[input.purpose] === 'required',
    });
    if (signed === null) {
      return { ok: false, reason: 'bad-assertion', userId: credential.userId };
    }
    // Applied only now that the signature is good: a forged assertion must not
    // be able to raise a counter-regression alarm.
    if (counterRegressed(credential.signCount, signed.newCounter)) {
      return { ok: false, reason: 'counter-regressed', userId: credential.userId };
    }

    return {
      ok: true,
      credential,
      newSignCount: signed.newCounter,
      userVerified: signed.userVerified,
      backedUp: signed.credentialBackedUp,
    };
  }

  /**
   * The relying party a ceremony runs for: `APP_URL`'s, unless a pin names
   * another host. Nothing is written here; only a registration pins, so an
   * install opened somewhere temporary before anyone registers stays unpinned.
   */
  async #relyingParty(): Promise<RelyingParty> {
    const relyingParty = relyingPartyFor(this.#appUrl);
    if (relyingParty === null) {
      throw new AuthFailure('passkeys-unavailable');
    }
    const pinned = await this.#pin.read();
    if (pinned !== null && pinned.rpId !== relyingParty.id) {
      throw new AuthFailure('passkeys-rp-changed');
    }
    return relyingParty;
  }

  /** The relying party for finishing a ceremony: the one it began under, and still allowed. */
  async #relyingPartyOf(ceremony: WebAuthnCeremony): Promise<RelyingParty> {
    const relyingParty = await this.#relyingParty();
    if (ceremony.rpId !== relyingParty.id) {
      throw new AuthFailure('passkeys-rp-changed');
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

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A WebAuthn authenticator in a few dozen lines of `node:crypto`: an ES256
 * key pair, a credential id and a counter, answering creation and request
 * options the way a browser and a platform authenticator together would.
 *
 * It exists so that the api's passkey code is tested against signatures it
 * did not make itself, without a browser. It signs whatever it is told to, so
 * a test can make it misbehave: another origin, no user verification, a
 * counter that goes backwards.
 */

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;

export interface SoftwareAuthenticatorOptions {
  readonly userVerified?: boolean;
  readonly backupEligible?: boolean;
  readonly backedUp?: boolean;
  /** The counter the next signature reports; 0 for a synced passkey that never counts. */
  readonly signCount?: number;
  readonly aaguid?: Uint8Array;
}

export interface CeremonyOverrides {
  /** The origin the "browser" puts in client data. */
  readonly origin: string;
  /** The RP ID hashed into authenticator data; the options' own by default. */
  readonly rpId?: string;
  readonly challenge?: string;
  readonly type?: string;
  readonly userVerified?: boolean;
  readonly signCount?: number;
  /** What the client data says about framing; a same-origin page by default. */
  readonly crossOrigin?: boolean;
  /**
   * The attestation statement a registration carries: `none` by default; a
   * `packed` self-attestation signed with the credential's key; or a `packed`
   * statement naming a (dummy) certificate chain.
   */
  readonly attestation?: 'none' | 'packed-self' | 'packed-x5c';
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

const uint32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

export class SoftwareAuthenticator {
  readonly credentialId: Uint8Array;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #options: Required<Omit<SoftwareAuthenticatorOptions, 'signCount'>>;
  signCount: number;

  constructor(options: SoftwareAuthenticatorOptions = {}) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
    this.credentialId = new Uint8Array(randomBytes(32));
    this.signCount = options.signCount ?? 0;
    this.#options = {
      userVerified: options.userVerified ?? true,
      backupEligible: options.backupEligible ?? false,
      backedUp: options.backedUp ?? false,
      aaguid: options.aaguid ?? new Uint8Array(16),
    };
  }

  /** The COSE public key, as a verified registration stores it. */
  get cosePublicKey(): Uint8Array {
    const jwk = this.#publicKey.export({ format: 'jwk' });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, COSE_KTY_EC2],
        [3, COSE_ALG_ES256],
        [-1, COSE_CRV_P256],
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
        [-3, Buffer.from(jwk.y ?? '', 'base64url')],
      ]),
    );
  }

  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    overrides: CeremonyOverrides,
  ): RegistrationResponseJSON {
    const clientDataJSON = this.#clientData('webauthn.create', options.challenge, overrides);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.#authDataHead(
        overrides.rpId ?? options.rp.id ?? '',
        overrides,
        FLAG_ATTESTED_CREDENTIAL,
      ),
      this.#options.aaguid,
      idLength,
      this.credentialId,
      this.cosePublicKey,
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, number | Uint8Array | Uint8Array[]>>([
        [
          'fmt',
          overrides.attestation === undefined || overrides.attestation === 'none'
            ? 'none'
            : 'packed',
        ],
        ['attStmt', this.#attestationStatement(overrides.attestation, authData, clientDataJSON)],
        ['authData', authData],
      ]),
    );

    return {
      id: base64url(this.credentialId),
      rawId: base64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: base64url(clientDataJSON),
        attestationObject: base64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: { credProps: { rk: true } },
    };
  }

  assert(
    options: PublicKeyCredentialRequestOptionsJSON,
    overrides: CeremonyOverrides,
  ): AuthenticationResponseJSON {
    const clientDataJSON = this.#clientData('webauthn.get', options.challenge, overrides);
    const authData = this.#authDataHead(overrides.rpId ?? options.rpId ?? '', overrides, 0);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.#privateKey,
    );
    this.signCount += 1;

    return {
      id: base64url(this.credentialId),
      rawId: base64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(authData),
        signature: base64url(signature),
      },
      clientExtensionResults: {},
    };
  }

  #attestationStatement(
    kind: CeremonyOverrides['attestation'],
    authData: Buffer,
    clientDataJSON: Buffer,
  ): Map<string, number | Uint8Array | Uint8Array[]> {
    if (kind === undefined || kind === 'none') {
      return new Map();
    }
    const sig = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.#privateKey);
    const statement = new Map<string, number | Uint8Array | Uint8Array[]>([
      ['alg', COSE_ALG_ES256],
      ['sig', sig],
    ]);
    if (kind === 'packed-x5c') {
      statement.set('x5c', [new Uint8Array(randomBytes(64))]);
    }
    return statement;
  }

  #clientData(type: string, challenge: string, overrides: CeremonyOverrides): Buffer {
    return Buffer.from(
      JSON.stringify({
        type: overrides.type ?? type,
        challenge: overrides.challenge ?? challenge,
        origin: overrides.origin,
        crossOrigin: overrides.crossOrigin ?? false,
      }),
    );
  }

  #authDataHead(rpId: string, overrides: CeremonyOverrides, extraFlags: number): Buffer {
    const userVerified = overrides.userVerified ?? this.#options.userVerified;
    const flags =
      FLAG_USER_PRESENT |
      (userVerified ? FLAG_USER_VERIFIED : 0) |
      (this.#options.backupEligible ? FLAG_BACKUP_ELIGIBLE : 0) |
      (this.#options.backedUp ? FLAG_BACKED_UP : 0) |
      extraFlags;
    return Buffer.concat([
      sha256(rpId),
      Buffer.from([flags]),
      uint32(overrides.signCount ?? this.signCount),
    ]);
  }
}

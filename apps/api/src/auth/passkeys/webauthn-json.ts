import type { WebauthnCredential } from '@helpdock/db';
import type { AuthenticationResponse, RegistrationResponse } from '@helpdock/schemas';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { StoredPasskey } from '../webauthn/webauthn.service.js';

/**
 * The validated body in the library's own shape. Optional fields are copied
 * only when present, because the library's types do not take `undefined`.
 */
export const toRegistrationJson = (response: RegistrationResponse): RegistrationResponseJSON => ({
  id: response.id,
  rawId: response.rawId,
  type: response.type,
  response: {
    clientDataJSON: response.response.clientDataJSON,
    attestationObject: response.response.attestationObject,
    ...(response.response.authenticatorData === undefined
      ? {}
      : { authenticatorData: response.response.authenticatorData }),
    ...(response.response.transports === undefined
      ? {}
      : { transports: response.response.transports }),
    ...(response.response.publicKeyAlgorithm === undefined
      ? {}
      : { publicKeyAlgorithm: response.response.publicKeyAlgorithm }),
    ...(response.response.publicKey === undefined
      ? {}
      : { publicKey: response.response.publicKey }),
  },
  ...(response.authenticatorAttachment === undefined
    ? {}
    : { authenticatorAttachment: response.authenticatorAttachment }),
  clientExtensionResults:
    response.clientExtensionResults.credProps?.rk === undefined
      ? {}
      : { credProps: { rk: response.clientExtensionResults.credProps.rk } },
});

export const toAuthenticationJson = (
  response: AuthenticationResponse,
): AuthenticationResponseJSON => ({
  id: response.id,
  rawId: response.rawId,
  type: response.type,
  response: {
    clientDataJSON: response.response.clientDataJSON,
    authenticatorData: response.response.authenticatorData,
    signature: response.response.signature,
    ...(response.response.userHandle === undefined
      ? {}
      : { userHandle: response.response.userHandle }),
  },
  ...(response.authenticatorAttachment === undefined
    ? {}
    : { authenticatorAttachment: response.authenticatorAttachment }),
  clientExtensionResults: {},
});

export const toStored = (row: WebauthnCredential): StoredPasskey => ({
  userId: row.userId,
  credentialId: row.credentialId,
  publicKey: row.publicKey,
  signCount: row.signCount,
  transports: row.transports,
});

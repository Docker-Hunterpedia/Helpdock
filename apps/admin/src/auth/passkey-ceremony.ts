import {
  type AuthenticationResponse,
  authenticationResponseSchema,
  type RegistrationResponse,
  registrationResponseSchema,
} from '@helpdock/schemas';
import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser';

/**
 * The browser half of a passkey ceremony (ADR 0050): hands the api's options
 * to `navigator.credentials` through `@simplewebauthn/browser` and says, in a
 * handful of words a screen can pick a sentence for, why it did not work.
 *
 * What comes back is parsed through the same schemas the api checks it with,
 * so nothing the browser adds beyond what the api reads is ever sent.
 */

export type PasskeyCeremonyFailure =
  /** The person dismissed the prompt, or it timed out: `NotAllowedError`, and nothing to report. */
  | 'cancelled'
  /** The authenticator already holds a passkey for this account. */
  | 'duplicate'
  | 'unsupported'
  | 'failed';

export class PasskeyCeremonyError extends Error {
  readonly reason: PasskeyCeremonyFailure;

  constructor(reason: PasskeyCeremonyFailure, options?: ErrorOptions) {
    super(`passkey ceremony: ${reason}`, options);
    this.name = 'PasskeyCeremonyError';
    this.reason = reason;
  }
}

export const isPasskeyCeremonyError = (error: unknown): error is PasskeyCeremonyError =>
  error instanceof PasskeyCeremonyError;

/** Whether this browser can run a ceremony at all (a secure context with `PublicKeyCredential`). */
export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

const failureOf = (error: unknown): PasskeyCeremonyFailure => {
  if (error instanceof WebAuthnError) {
    if (error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'duplicate';
    if (error.code === 'ERROR_CEREMONY_ABORTED') return 'cancelled';
    if (error.cause instanceof Error && error.cause.name === 'NotAllowedError') return 'cancelled';
    return 'failed';
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'cancelled';
  return 'failed';
};

/**
 * `options` are the ones `@simplewebauthn/server` made, passed through the api
 * untouched, so the cast below only names what they already are.
 */
export const createPasskey = async (
  options: Readonly<Record<string, unknown>>,
): Promise<RegistrationResponse> => {
  if (!passkeysSupported()) {
    throw new PasskeyCeremonyError('unsupported');
  }
  try {
    return registrationResponseSchema.parse(
      await startRegistration({
        optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
      }),
    );
  } catch (error) {
    throw new PasskeyCeremonyError(failureOf(error), { cause: error });
  }
};

export const assertPasskey = async (
  options: Readonly<Record<string, unknown>>,
): Promise<AuthenticationResponse> => {
  if (!passkeysSupported()) {
    throw new PasskeyCeremonyError('unsupported');
  }
  try {
    return authenticationResponseSchema.parse(
      await startAuthentication({
        optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
      }),
    );
  } catch (error) {
    throw new PasskeyCeremonyError(failureOf(error), { cause: error });
  }
};
